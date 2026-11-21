# LUTView

Local, offline display-LUT explorer for the two XML files in this directory.
Requires Windows, Node.js 20+ and the .NET 9 SDK. No npm packages or downloads
are required. The .NET bridge supplies standards-based XML parsing as well as
optional native display APIs.

```powershell
Set-Location 'D:\workspace\US\code\LUTView'
npm run build:native
npm test
npm start
```

Open <http://127.0.0.1:3210>. Set `$env:PORT = '3211'` before starting to
use another port. The server binds only to loopback.

## Explore

- Main display: select BlackLevel, Tint and AmbientLight. The matrix shows
  a BlackLevel x AmbientLight slice for each Tint layer.
- Touch screen: only AmbientLight is active. Main and TS tables target
  different displays; they are not composed together.
- Edit `correctionLUT.xml` or `TSCorrectionLUT.xml`, then click the reload
  button. Invalid values, missing rows, wrong dimensions and malformed XML
  are errors; old data cannot be applied after a failed reload.
  Hardware requests also verify the XML hash against the preview; changes
  made on disk after loading require a reload before applying.
- Every Ambient contains three 256-entry one-dimensional transfer tables.
  Charts and the raw-data table show both XML and API values.
- RGB is plotted as connected curves through all 256 entries per channel.
  Overlapping curves use different line widths; the selected input-index
  points use concentric marker sizes (R large, G medium, B small).
  The chart fits its panel without scrolling. Connecting entries is a
  visual aid only and does not change the lookup data.
  Only XML RGB/backlight data is plotted;
  there is no theoretical identity reference line.
- The chart also shows the selected Ambient's `lcdBacklight` as an orange
  horizontal dashed line on a separate 0-100% right axis. It is one panel
  setting, not a fourth Gamma LUT or a multiplier applied to RGB. Missing
  TS backlight data is marked unavailable; no line or default is invented.
- Test patterns include grayscale ramps, near-black steps, color patches
  and a synthetic sector pattern (not a clinical image).
- Matrix and RGB curves are compact auxiliary panels; image comparison uses
  the full workspace width and larger 768 x 480 canvases. Expand the panel
  explanations to inspect indexing, pipeline details and all 256 entries.
- Main-display selection uses a projected 3D lattice: AmbientLight runs
  right, BlackLevel up, and Tint into depth as stacked planes. Click a point
  (or focus it and press Enter/Space) to select all three coordinates.
  The active Tint plane and selected point are highlighted; per-point flat
  indices are omitted visually but the current index remains in the formula.
  Projection does not interpolate or modify XML values. Touch-screen
  selection remains one-dimensional.
- Imported images stay in the browser; no upload or external resources.

## Verified UltVMQ behavior

Source locations relative to `VMQ_HAL\NezhaDev`:

- `ULTVMQ\vgrServices\common\lds\src\ldsFileReader.cpp`, lines 420/434 and
  706/720: XML values are 15-bit; both main and TS readers left-shift each
  value once to produce the 16-bit table.
- `ULTVMQ\vgrServices\common\lds\ldsmain.cpp`, line 385:
  `index = Ambient + Tint * AmbientCount + BlackLevel * AmbientCount * TintCount`.
  All indices are zero-based. The knobs select a table, not a 3x3 RGB
  mixing matrix and not three multiplicative gains.
- `ULTVMQ\vgrSpath\fcc\src\fc\fcsdf.cpp`, lines 325 and 379:
  `IgfxExt.CUIExternal`, `ICUIExternal8`, `SetGammaRamp`, selected monitor UID,
  three consecutive 256-WORD channels (1536 bytes).
- `ULTVMQ\vgrSpath\fcc\src\fc\fcLcdBacklight.cpp`, line 67:
  independent `SetBrightness(fullScaleLumens * lcdBacklight)` call.
- `UltHAL\projects\HwDev\HwDevDivaDisplayUtlImpl.cpp`, line 306:
  DIVA USB brightness receives nits (60-300, with rail behavior); DIVA OLED
  has no LCD backlight. The legacy field name does not imply an LCD panel.

The supplied main XML contains 6 x 5 x 7 = 210 Ambients.
The supplied TS XML contains 3 Ambients. Do not normalize each table by its
own maximum: a reduced white endpoint is intentional data.
In this supplied main XML, all RGB channels are equal and all Tint layers
have identical RGB tables for a given BlackLevel/Ambient. Changing Tint
therefore does not alter the GPU LUT; backlight and panel custom commands
can still differ. The viewer reports this from the actual data rather than
inventing a software tint effect.
The software preview uses `round(XML[i] * 2 / 65535 * 255)`, not a physical
luminance model or a guarantee of calibrated appearance.

## Optional real-display trial

No display writes happen on startup or when moving knobs. Select a target,
check the explicit consent box and press one of the trial buttons.
Each trial saves the original value, writes the selected XML data, checks
readback and restores after 15 seconds. Press **restore** for earlier undo.
To try another knob combination, select it and press **trial** again.
The timer restarts; the original pre-trial value remains the restore target.

There are distinct paths, with no automatic fallback:

1. **Intel CUI**: the same legacy COM interface as UltVMQ. Requires a driver
   that registers `IgfxExt.CUIExternal` and exposes `ICUIExternal8`.
   Modern Intel GPUs do not necessarily provide this interface.
2. **Windows GDI**: `SetDeviceGammaRamp` on a manually selected Windows
   display. A genuine desktop gamma trial, but **not** the Intel CUI path.
3. **DDC/CI brightness**: separate `SetMonitorBrightness` call on a Windows
   physical monitor. Maps XML `lcdBacklight` to the device min-max range.
   This is **not** the Philips DIVA USB/nits interface, and does not promise
   the same luminance. It can fail when DDC/CI is unsupported.

RGB trial and brightness trial use separate buttons. Software LUT preview
is suspended during any active hardware trial to avoid double correction.
Readback equality is checked; visible/optical calibration is not verified.
Use local SDR sessions. HDR, Remote Desktop, clone groups, ICC loaders,
driver policy and other calibration programs can prevent or override writes.
Device refresh performs a read-only GDI Gamma capability check. A target
whose original Gamma cannot be read is disabled, not assigned an identity
fallback. Remote virtual targets are disabled for both Gamma and DDC/CI.
The native bridge rechecks this restriction before hardware operations.

### Intel unavailable / GetDeviceGammaRamp failed

- `CO_E_CLASSSTRING` means the legacy `IgfxExt.CUIExternal` COM class is not
  registered. A modern Intel driver or an installed Intel GPU alone does
  not supply that legacy interface. Do not downgrade drivers just to enable it.
- `Microsoft Remote Display Adapter` is a virtual desktop target. It does
  not expose the physical monitor's Gamma/backlight interface. Start both
  Node and the native bridge in the local desktop session on the machine
  driving the physical monitor. Opening a local browser while Node remains
  in the remote session does not move the display API to the local session.
- On a physical local SDR desktop, refresh devices and select the correct
  target. If Gamma read still fails, the driver/API does not support this
  path; no hardware write is attempted. Software preview remains usable.
- Read-only diagnostics (no server needed):
  `native\bin\Release\net9.0-windows\LUTBridge.exe --diagnose`.

Do not use during clinical work or on displays shared by other users.

Snapshots are saved to
`native\bin\Release\net9.0-windows\display-recovery.json` before writing.
Normal stdin EOF (including server shutdown) restores snapshots. The native
timer also runs if the browser is closed. An abnormal bridge termination,
OS crash, disconnected screen or hung driver can prevent restoration.
Restart the tool to attempt recovery; unsuccessful recovery retains the
file and reports an error. Never delete a recovery file before restoring.
Run only one bridge per Windows session.

Not implemented: Philips vendor USB command transport, `customLutData`,
`customInitData`, saturation commands, SVIO, Protego non-PWM compensation,
automatic Main/TS monitor identification, physical luminance measurement.
These are deliberately not represented as successful operations.

## Validation

`npm test` covers the supplied XML dimensions, every main-display coordinate,
15-to-16-bit conversion, TS white endpoint, per-channel mapping, alpha
preservation and malformed-input rejection. Native build uses warnings as
errors. Real display writes require deliberate user confirmation and are
not part of automated tests.
