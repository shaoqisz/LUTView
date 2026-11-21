using System.ComponentModel;
using System.Runtime.InteropServices;

internal static class DisplayApi
{
    internal sealed record Capability(string id, string label, bool primary, uint flags,
        bool remote, bool gammaSupported, string? gammaError, bool brightnessSupported, string? brightnessError);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct DisplayDevice
    {
        public uint Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct PhysicalMonitor
    {
        public IntPtr Handle;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public uint Size;
        public int Left, Top, Right, Bottom, WorkLeft, WorkTop, WorkRight, WorkBottom;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, IntPtr rect, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool EnumDisplayDevices(string? name, uint index, ref DisplayDevice device, uint flags);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr rect, MonitorCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("gdi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateDC(string driver, string device, IntPtr output, IntPtr init);
    [DllImport("gdi32.dll")] private static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll", SetLastError = true)] private static extern bool GetDeviceGammaRamp(IntPtr dc, [Out] byte[] ramp);
    [DllImport("gdi32.dll", SetLastError = true)] private static extern bool SetDeviceGammaRamp(IntPtr dc, byte[] ramp);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr monitor, out uint count);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr monitor, uint count, [Out] PhysicalMonitor[] physical);
    [DllImport("dxva2.dll")] private static extern bool DestroyPhysicalMonitors(uint count, PhysicalMonitor[] physical);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool GetMonitorBrightness(IntPtr monitor, out uint min, out uint current, out uint max);
    [DllImport("dxva2.dll", SetLastError = true)] private static extern bool SetMonitorBrightness(IntPtr monitor, uint value);

    public static List<DisplayDevice> Devices()
    {
        var result = new List<DisplayDevice>();
        for (uint i = 0; ; i++)
        {
            var device = new DisplayDevice { Size = (uint)Marshal.SizeOf<DisplayDevice>() };
            if (!EnumDisplayDevices(null, i, ref device, 0)) break;
            if ((device.Flags & 1) != 0 && (device.Flags & 8) == 0) result.Add(device);
        }
        return result;
    }
    public static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }
    private static bool IsRemote(DisplayDevice device) =>
        GetSystemMetrics(0x1000) != 0 || (device.Flags & 0x04000000) != 0 ||
        device.Description.Contains("Remote Display", StringComparison.OrdinalIgnoreCase);
    private static string RemoteReason =>
        "当前目标是远程桌面虚拟显示器，不提供物理屏幕 Gamma / DDC 背光接口。请在连接物理显示器的本地桌面启动 Node 服务器（仅更换浏览器无效）。";
    private static DisplayDevice PhysicalDevice(string name)
    {
        var matches = Devices().Where(d => d.Name == name).ToArray();
        if (matches.Length != 1) throw new InvalidOperationException("Display is disconnected or unknown");
        if (IsRemote(matches[0])) throw new InvalidOperationException(RemoteReason);
        return matches[0];
    }
    public static Capability[] Capabilities() => Devices().Select(device =>
    {
        bool remote = IsRemote(device);
        string? gammaError = remote ? RemoteReason : null;
        if (!remote)
        {
            try { Gamma(device.Name); }
            catch (Exception error) when (error is Win32Exception or InvalidOperationException)
            {
                gammaError = "无法读取原始 Gamma，禁止试用以保证可恢复。请检查本地 SDR / HDR 设置及驱动支持。 " + error.Message;
            }
        }
        return new Capability(device.Name, $"{device.Name} / {device.Description}", (device.Flags & 4) != 0,
            device.Flags, remote, gammaError is null, gammaError, !remote, remote ? RemoteReason : null);
    }).ToArray();
    public static byte[] Gamma(string device, byte[]? write = null)
    {
        PhysicalDevice(device);
        var dc = CreateDC("DISPLAY", device, IntPtr.Zero, IntPtr.Zero);
        if (dc == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateDC failed");
        try
        {
            if (write is not null) Check(SetDeviceGammaRamp(dc, write), "SetDeviceGammaRamp");
            var result = new byte[1536];
            Check(GetDeviceGammaRamp(dc, result), "GetDeviceGammaRamp");
            return result;
        }
        finally { DeleteDC(dc); }
    }
    public static (uint min, uint current, uint max) Brightness(string device, uint? write = null)
    {
        PhysicalDevice(device);
        IntPtr selected = IntPtr.Zero;
        string? failure = null;
        Check(EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (handle, _, _, _) =>
        {
            var info = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
            if (!GetMonitorInfo(handle, ref info)) failure = "GetMonitorInfo failed";
            else if (info.Device == device) selected = handle;
            return true;
        }, IntPtr.Zero), "EnumDisplayMonitors");
        if (failure is not null) throw new InvalidOperationException(failure);
        if (selected == IntPtr.Zero) throw new InvalidOperationException("No physical monitor for selected display");
        Check(GetNumberOfPhysicalMonitorsFromHMONITOR(selected, out var count), "Physical monitor count");
        if (count != 1) throw new InvalidOperationException("Expected exactly one physical monitor; clone/remote groups are not supported");
        var physical = new PhysicalMonitor[count];
        Check(GetPhysicalMonitorsFromHMONITOR(selected, count, physical), "Physical monitor enumeration");
        try
        {
            if (write.HasValue) Check(SetMonitorBrightness(physical[0].Handle, write.Value), "SetMonitorBrightness");
            Check(GetMonitorBrightness(physical[0].Handle, out var min, out var current, out var max), "GetMonitorBrightness (DDC/CI may be unsupported)");
            return (min, current, max);
        }
        finally { DestroyPhysicalMonitors(count, physical); }
    }
}
