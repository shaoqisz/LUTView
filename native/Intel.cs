using System.Runtime.InteropServices;

// IUnknown vtable order follows the inherited ICUIExternal2..6 contract.
// The ICUIExternal8 IID exposes the same prefix used by UltVMQ.
[ComImport, Guid("F932C038-6484-45CA-8FA1-7C8C279F7AEE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IIntelCui
{
    [PreserveSig] int EnumActiveDevices([MarshalAs(UnmanagedType.BStr)] string name, uint index, out uint uid, ref uint type);
    [PreserveSig] int GetConfiguration(ref Guid guid, uint size, IntPtr data, out uint error);
    [PreserveSig] int SupportedEvents(uint uid, out uint value);
    [PreserveSig] int RegisterEvent([MarshalAs(UnmanagedType.BStr)] string name, uint uid, uint mask, out uint id, out uint error);
    [PreserveSig] int RegisterNotify(IntPtr notify, uint uid, uint mask, out uint id, out uint error);
    [PreserveSig] int DeRegisterEvent(uint id, out uint error);
    [PreserveSig] int DeRegisterNotify(uint id, out uint error);
    [PreserveSig] int SetConfiguration(ref Guid guid, uint size, IntPtr data, out uint error);
    [PreserveSig] int ChangeActiveDevices(ref Guid guid, uint size, IntPtr data, out uint error);
    [PreserveSig] int EnumAttachableDevices([MarshalAs(UnmanagedType.BStr)] string name, uint index, out uint uid, ref uint type, out uint status);
    [PreserveSig] int MccsOpen(uint uid, out uint handle, out uint error);
    [PreserveSig] int MccsClose(uint handle);
    [PreserveSig] int MccsGetMax(uint handle, uint code, uint size, out uint value, out uint error);
    [PreserveSig] int MccsGetMin(uint handle, uint code, uint size, out uint value, out uint error);
    [PreserveSig] int MccsGetCurrent(uint handle, uint code, uint size, out uint value, out uint error);
    [PreserveSig] int MccsSetCurrent(uint handle, uint code, uint size, uint value, out uint error);
    [PreserveSig] int PowerApiOpen(out uint handle, out uint error);
    [PreserveSig] int PowerApiClose(uint handle, out uint error);
    [PreserveSig] int GetPowerConsCaps(uint handle, out uint caps, out uint error);
    [PreserveSig] int GetPowerPolicy(uint handle, uint policy, ref Guid guid, uint size, IntPtr data, out uint error);
    [PreserveSig] int SetPowerPolicy(uint handle, uint policy, ref Guid guid, uint size, IntPtr data, out uint error);
    [PreserveSig] int GetGammaRamp(uint uid, uint size, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] byte[] data, out uint error);
    [PreserveSig] int SetGammaRamp(uint uid, uint size, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 1)] byte[] data, out uint error);
}
