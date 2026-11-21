using System.Runtime.InteropServices;
using System.Text.Json;
using System.Xml;
using System.Xml.Linq;

internal sealed record Snapshot(string Backend, string Display, byte[]? Gamma, uint? Brightness);
internal sealed record Request(int Id, string Action, string? Backend, string? Display, int[][]? Rows, double? Brightness);

internal static class Program
{
    private static readonly object Gate = new();
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly string RecoveryFile = Path.Combine(AppContext.BaseDirectory, "display-recovery.json");
    private static readonly List<Snapshot> Saved = [];
    private static DateTime deadline;
    private static IIntelCui? intel;
    private static string? intelError;
    private static bool recoveryBlocked;

    private static void Emit(object message) => Console.WriteLine(JsonSerializer.Serialize(message));
    private static void IntelCheck(int hr, uint error, string action)
    {
        if (hr < 0 || error != 0) throw new InvalidOperationException($"{action}: HRESULT 0x{hr:X8}, Intel error 0x{error:X}");
    }
    private static uint Uid(string display)
    {
        if (intel is null) throw new InvalidOperationException(intelError ?? "Intel CUI unavailable");
        if (!display.StartsWith("intel:") || !uint.TryParse(display[6..], out var uid))
            throw new InvalidOperationException("Choose an Intel monitor UID, not a Windows display name");
        if (!IntelDevices().Any(d => d.uid == uid)) throw new InvalidOperationException("Intel UID is no longer attached");
        return uid;
    }
    private static List<(uint uid, string adapter, uint type, uint status)> IntelDevices()
    {
        var devices = new List<(uint, string, uint, uint)>();
        if (intel is null) return devices;
        foreach (var adapter in DisplayApi.Devices())
        {
            for (uint i = 0; i < 32; i++)
            {
                uint type = 0;
                int hr = intel.EnumAttachableDevices(adapter.Name, i, out uint uid, ref type, out uint flags);
                if (hr == 1) break; // S_FALSE is end-of-enumeration.
                IntelCheck(hr, 0, "EnumAttachableDevices");
                if ((flags & 2) != 0 && !devices.Any(d => d.Item1 == uid))
                    devices.Add((uid, adapter.Name, type, flags));
            }
        }
        return devices;
    }
    private static byte[] Gamma(string backend, string display, byte[]? write = null)
    {
        if (backend == "gdi") return DisplayApi.Gamma(display, write);
        if (backend != "intel") throw new InvalidOperationException("Unknown gamma backend");
        uint uid = Uid(display);
        if (write is not null) IntelCheck(intel!.SetGammaRamp(uid, 1536, write, out var error), error, "Intel SetGammaRamp");
        var read = new byte[1536];
        IntelCheck(intel!.GetGammaRamp(uid, 1536, read, out var readError), readError, "Intel GetGammaRamp");
        return read;
    }
    private static void Save(Snapshot snapshot)
    {
        if (!Saved.Any(s => s.Backend == snapshot.Backend && s.Display == snapshot.Display))
        {
            Saved.Add(snapshot);
            try
            {
                File.WriteAllText(RecoveryFile + ".tmp", JsonSerializer.Serialize(Saved));
                File.Move(RecoveryFile + ".tmp", RecoveryFile, true);
            }
            catch { Saved.Remove(snapshot); throw; }
        }
    }
    private static void Restore()
    {
        var errors = new List<string>();
        foreach (var snapshot in Saved.ToArray())
        {
            try
            {
                if (snapshot.Gamma is not null)
                {
                    var actual = Gamma(snapshot.Backend, snapshot.Display, snapshot.Gamma);
                    if (!actual.SequenceEqual(snapshot.Gamma)) throw new InvalidOperationException("Gamma restore readback mismatch");
                }
                if (snapshot.Brightness.HasValue)
                {
                    var actual = DisplayApi.Brightness(snapshot.Display, snapshot.Brightness.Value);
                    if (actual.current != snapshot.Brightness.Value) throw new InvalidOperationException("Brightness restore readback mismatch");
                }
                Saved.Remove(snapshot);
            }
            catch (Exception error) { errors.Add($"{snapshot.Display}: {error.Message}"); }
        }
        if (Saved.Count == 0) { if (File.Exists(RecoveryFile)) File.Delete(RecoveryFile); }
        else File.WriteAllText(RecoveryFile, JsonSerializer.Serialize(Saved));
        recoveryBlocked = errors.Count != 0;
        if (recoveryBlocked) throw new InvalidOperationException("RESTORE FAILED; recovery file retained. " + string.Join("; ", errors));
    }
    private static object State() => new { active = Saved.Count != 0, expires = deadline, error = (string?)null };
    private static object Execute(Request req)
    {
        if (req.Action == "list") return new
        {
            windows = DisplayApi.Capabilities(),
            intel = IntelDevices().Select(d => new { id = $"intel:{d.uid}", label = $"UID {d.uid} / {d.adapter} / type {d.type} / flags 0x{d.status:X}" }),
            intelError,
            recoveryPending = Saved.Count != 0
        };
        if (req.Action == "restore") { Restore(); return State(); }
        if (recoveryBlocked || (File.Exists(RecoveryFile) && Saved.Count == 0)) throw new InvalidOperationException("Recovery required before new writes");
        if (string.IsNullOrWhiteSpace(req.Display)) throw new InvalidOperationException("Display required");
        // Do not layer two gamma APIs over the same physical desktop.
        if (req.Action == "gamma" && Saved.Any(s => s.Gamma is not null && s.Backend != req.Backend))
            throw new InvalidOperationException("Restore before changing gamma backend");
        deadline = DateTime.UtcNow.AddSeconds(15);
        try
        {
            if (req.Action == "gamma")
            {
                if (req.Backend is not ("intel" or "gdi")) throw new InvalidOperationException("Backend required");
                if (req.Rows is null || req.Rows.Length != 3 || req.Rows.Any(r => r is null || r.Length != 256 || r.Any(v => v < 0 || v > 65534 || (v & 1) != 0)))
                    throw new InvalidOperationException("Expected 3 x 256 even 16-bit values from 15-bit XML");
                var bytes = new byte[1536];
                for (int c = 0; c < 3; c++)
                    for (int i = 0; i < 256; i++)
                    {
                        ushort value = (ushort)req.Rows[c][i];
                        int offset = (c * 256 + i) * 2;
                        bytes[offset] = (byte)value;
                        bytes[offset + 1] = (byte)(value >> 8);
                    }
                Save(new Snapshot(req.Backend, req.Display, Gamma(req.Backend, req.Display), null));
                var actual = Gamma(req.Backend, req.Display, bytes);
                if (!actual.SequenceEqual(bytes)) throw new InvalidOperationException("Gamma API returned but readback differs (HDR/driver/remote-session restrictions); restoring");
            }
            else if (req.Action == "brightness")
            {
                if (req.Brightness is null || !double.IsFinite(req.Brightness.Value) || req.Brightness < 0 || req.Brightness > 1)
                    throw new InvalidOperationException("This Ambient has no valid lcdBacklight");
                var original = DisplayApi.Brightness(req.Display);
                if (original.max <= original.min) throw new InvalidOperationException("Invalid brightness range");
                uint target = original.min + (uint)Math.Round(req.Brightness.Value * (original.max - original.min));
                Save(new Snapshot("ddc", req.Display, null, original.current));
                if (DisplayApi.Brightness(req.Display, target).current != target) throw new InvalidOperationException("Brightness readback mismatch; restoring");
            }
            else throw new InvalidOperationException("Unknown action");
            deadline = DateTime.UtcNow.AddSeconds(15);
            return State();
        }
        catch (Exception applyError)
        {
            try { Restore(); }
            catch (Exception restoreError) { throw new AggregateException(applyError.Message + "; " + restoreError.Message, applyError, restoreError); }
            throw;
        }
    }
    [MTAThread]
    public static int Main(string[] args)
    {
        if (args.SequenceEqual(new[] { "--parse-xml" })) return ParseXml();
        if (args.SequenceEqual(new[] { "--diagnose" }))
        {
            try { Emit(new { windows = DisplayApi.Capabilities() }); return 0; }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }
        using var mutex = new Mutex(false, @"Local\LUTViewDisplayBridge");
        if (!mutex.WaitOne(0)) { Console.Error.WriteLine("Another LUTView bridge is running"); return 1; }
        try
        {
            try
            {
                var type = Type.GetTypeFromProgID("IgfxExt.CUIExternal", throwOnError: true)!;
                intel = (IIntelCui)Activator.CreateInstance(type)!;
            }
            catch (Exception error)
            {
                intelError = "旧版 Intel CUI (IgfxExt.CUIExternal / ICUIExternal8) 不可用；安装 Intel GPU 驱动不保证包含此接口。不能把 GDI 冒充 CUI，也不建议为此强行降级驱动。 " + error.Message;
            }
            if (File.Exists(RecoveryFile))
            {
                Saved.AddRange(JsonSerializer.Deserialize<List<Snapshot>>(File.ReadAllText(RecoveryFile)) ?? throw new InvalidOperationException("Invalid recovery file"));
                try { Restore(); Emit(new { @event = "recovered", active = false }); }
                catch (Exception error) { Emit(new { @event = "restore-error", active = true, error = error.Message }); }
            }
            using var timer = new System.Threading.Timer(_ =>
            {
                lock (Gate)
                {
                    if (Saved.Count == 0 || DateTime.UtcNow < deadline) return;
                    try { Restore(); Emit(new { @event = "restored", active = false }); }
                    catch (Exception error) { Emit(new { @event = "restore-error", active = true, error = error.Message }); }
                }
            }, null, 1000, 1000);
            string? line;
            while ((line = Console.ReadLine()) is not null)
            {
                int id = 0;
                lock (Gate)
                {
                    try
                    {
                        var req = JsonSerializer.Deserialize<Request>(line, JsonOptions) ?? throw new InvalidOperationException("Invalid request");
                        id = req.Id;
                        Emit(new { id, result = Execute(req) });
                    }
                    catch (Exception error)
                    {
                        Emit(new { id, error = error.Message, state = new
                        {
                            active = Saved.Count != 0, expires = deadline,
                            error = Saved.Count != 0 ? error.Message : null
                        } });
                    }
                }
            }
            lock (Gate) { Restore(); }
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            if (intel is not null) Marshal.ReleaseComObject(intel);
            mutex.ReleaseMutex();
        }
    }
    private static int ParseXml()
    {
        try
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024 };
            using var reader = XmlReader.Create(Console.In, settings);
            var document = XDocument.Load(reader);
            var root = document.Root ?? throw new XmlException("Missing root");
            Emit(new Dictionary<string, object> { [root.Name.LocalName] = XmlValue(root) });
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }
    private static object XmlValue(XElement element)
    {
        if (!element.HasElements) return element.Value.Trim();
        var result = new Dictionary<string, object>();
        foreach (var group in element.Elements().GroupBy(child => child.Name.LocalName))
        {
            bool array = group.Key is "BlackLevel" or "ColorTemp" or "Ambient";
            if (!array && group.Count() != 1) throw new XmlException("Duplicate element: " + group.Key);
            result[group.Key] = array ? group.Select(XmlValue).ToArray() : XmlValue(group.Single());
        }
        return result;
    }
}
