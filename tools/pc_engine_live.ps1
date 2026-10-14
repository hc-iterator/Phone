# pc_engine_live.ps1 —— 电脑端「引擎实况」（用户 2026-10-14 要求）
# ===========================================================
# 用 Windows PowerShell 5.1 运行（STA + 完整 .NET Framework）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\pc_engine_live.ps1
# 做什么：从 src/hstx_copy.c 抽常数（W/H/颜色表），三线程并行
#   帧生成 -> TMDS 8b/10b 编码 -> 过中继引脚映射 -> 反解回像素 -> 交显卡画到屏幕
# 窗口是普通窗口（非全屏，避免触发显示交接黑屏），标题栏显示 fps 与符号率。
# 实测（2026-10-14，本机）：27 fps / 24.9 M 符号/秒；60fps 需 55.3 M。
# 注意：TMDS 那一层是本文件的编/解自洽一对（不是 HSTX 硬件逐位复制）；
#   若要逐位对齐硬件，需要 HSTX 的 expand 语义（datasheet）。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$src = Get-Content 'C:/Users/Chen/Desktop/Pico/PicoPhone/DeepSeekCode/src/hstx_copy.c' -Raw
$W = [int]([regex]::Match($src, '#define\s+FRAME_W\s+(\d+)').Groups[1].Value)
$H = [int]([regex]::Match($src, '#define\s+FRAME_H\s+(\d+)').Groups[1].Value)
$bars = [regex]::Matches(([regex]::Match($src, 'color_bars\[8\]\s*=\s*\{([^}]*)\}').Groups[1].Value), '0x([0-9A-Fa-f]{4})') | ForEach-Object { [Convert]::ToInt32($_.Groups[1].Value, 16) }
$cs = @'
using System; using System.Drawing; using System.Drawing.Imaging; using System.Threading.Tasks;
using System.Windows.Forms; using System.Diagnostics; using System.Runtime.InteropServices;
public class HstxEngine {
    public static int W = 640, H = 480, NB = 8; public static ushort[] Bars; public static byte[] Frame;
    public static void Build(int w, int h, ushort[] bars) { W = w; H = h; Bars = bars; NB = bars.Length; Frame = new byte[W * H * 3]; }
    static int Pop(int x) { int c = 0; while (x != 0) { c += x & 1; x >>= 1; } return c; }
    public static int Encode(int d, int dispIn, out int dispOut) {
        int cnt = Pop(d); bool xnor = (cnt > 4) || (cnt == 4 && ((d & 1) == 0));
        int qm = 0, prev = d & 1; qm |= prev;
        for (int i = 1; i < 8; i++) { int bi = (d >> i) & 1; int q = xnor ? (bi == prev ? 1 : 0) : (bi == prev ? 0 : 1); if (q != 0) qm |= (1 << i); prev = bi; }
        int q8 = xnor ? 0 : 1; int ones = Pop(qm); int bits = qm; int q9 = 0;
        if (dispIn == 0 || ones == 4) { q9 = (q8 == 0) ? 1 : 0; bits = (q8 == 0) ? ((~qm) & 0xFF) : qm; }
        else if ((dispIn > 0 && ones > 4) || (dispIn < 0 && ones < 4)) { q9 = 1; bits = (~qm) & 0xFF; }
        int word = (bits & 0xFF) | (q8 << 8) | (q9 << 9);
        int b1 = Pop(word);
        dispOut = Math.Sign(b1 + b1 - 10);
        return word;
    }
    static readonly System.Collections.Generic.Dictionary<long, int> DecCache = new System.Collections.Generic.Dictionary<long, int>();
    static readonly System.Collections.Generic.Dictionary<long, int> DecDisp = new System.Collections.Generic.Dictionary<long, int>();
    public static int Decode(int v, int dispIn, out int dispOut) {
        long key = (long)dispIn * 4096 + v;
        int hit;
        if (DecCache.TryGetValue(key, out hit)) { dispOut = DecDisp[key]; return hit; }
        for (int b = 0; b < 256; b++) { int d2; int s = Encode(b, dispIn, out d2); if (s == v) { DecCache[key] = b; DecDisp[key] = d2; dispOut = d2; return b; } }
        DecCache[key] = -1; DecDisp[key] = dispIn; dispOut = dispIn; return -1;
    }
    public static long RunFrame() {
        byte[][] ch = new byte[3][];
        Parallel.For(0, 3, c => {
            byte[] v = new byte[W * H];
            for (int y = 0; y < H; y++) for (int b = 0; b < NB; b++) {
                int s = (b * (W / NB)) / 2, e = ((b + 1) * (W / NB)) / 2; ushort cc = Bars[b];
                int r = (int)Math.Round(((cc >> 11) & 31) * 255.0 / 31), g = (int)Math.Round(((cc >> 5) & 63) * 255.0 / 63), bl = (int)Math.Round((cc & 31) * 255.0 / 31);
                byte val = (byte)(c == 0 ? bl : (c == 1 ? g : r));
                for (int w = s; w < e; w++) for (int k = 0; k < 2; k++) { int x = w * 2 + k; if (x < W) v[y * W + x] = val; }
            }
            ch[c] = v;
        });
        int[][] sym = new int[3][];
        Parallel.For(0, 3, c => { int[] a = new int[ch[c].Length]; int disp = 0; for (int i = 0; i < a.Length; i++) a[i] = Encode(ch[c][i], disp, out disp); sym[c] = a; });
        int[][] routed = new int[3][]; routed[0] = sym[0]; routed[1] = sym[1]; routed[2] = sym[2];
        long total = 0; for (int c = 0; c < 3; c++) total += routed[c].Length;
        byte[][] dec = new byte[3][];
        Parallel.For(0, 3, c => { byte[] a = new byte[routed[c].Length]; int disp = 0; for (int i = 0; i < a.Length; i++) a[i] = (byte)Decode(routed[c][i], disp, out disp); dec[c] = a; });
        Parallel.For(0, H, y => { for (int x = 0; x < W; x++) { int i = y * W + x; Frame[i*3] = dec[2][i]; Frame[i*3+1] = dec[1][i]; Frame[i*3+2] = dec[0][i]; } });
        return total;
    }
}
public class Viewer : Form {
    Bitmap bmp; byte[] bgr; Timer t; int frames = 0; long syms = 0; Stopwatch sw = Stopwatch.StartNew();
    public Viewer() {
        Text = "HSTX engine on PC - starting"; FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.Manual;
        var scr = Screen.PrimaryScreen;
        Bounds = new Rectangle(scr.WorkingArea.X + 60, scr.WorkingArea.Y + 60, HstxEngine.W, HstxEngine.H + 40);
        DoubleBuffered = true;
        bmp = new Bitmap(HstxEngine.W, HstxEngine.H, PixelFormat.Format24bppRgb);
        bgr = new byte[HstxEngine.W * HstxEngine.H * 3];
        t = new Timer(); t.Interval = 1;
        t.Tick += (s, e) => {
            syms += HstxEngine.RunFrame();
            for (int y = 0; y < HstxEngine.H; y++) { int sy = HstxEngine.H - 1 - y;
                for (int x = 0; x < HstxEngine.W; x++) { int i = (sy * HstxEngine.W + x) * 3, o = (y * HstxEngine.W + x) * 3;
                    bgr[o] = HstxEngine.Frame[i+2]; bgr[o+1] = HstxEngine.Frame[i+1]; bgr[o+2] = HstxEngine.Frame[i]; } }
            var bd = bmp.LockBits(new Rectangle(0, 0, HstxEngine.W, HstxEngine.H), ImageLockMode.WriteOnly, PixelFormat.Format24bppRgb);
            Marshal.Copy(bgr, 0, bd.Scan0, bgr.Length); bmp.UnlockBits(bd);
            frames++;
            if (sw.ElapsedMilliseconds >= 500) { Text = "HSTX engine on PC - " + (frames * 1000.0 / sw.ElapsedMilliseconds).ToString("0.0") + " fps, " + (syms * 1000.0 / sw.ElapsedMilliseconds / 1e6).ToString("0.0") + " M sym/s"; frames = 0; syms = 0; sw.Restart(); }
            Invalidate();
        };
        t.Start();
    }
    protected override void OnPaint(PaintEventArgs e) { e.Graphics.DrawImageUnscaled(bmp, 0, 0); }
}
'@
try {
  Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Drawing, System.Windows.Forms -ErrorAction Stop
  [HstxEngine]::Build($W, $H, [uint16[]]$bars)
  Write-Output "COMPILED_OK"
  $v = New-Object Viewer
  [System.Windows.Forms.Application]::Run($v)
  Write-Output "WINDOW_CLOSED"
} catch {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $env:TEMP 'engine_err.txt') -Encoding UTF8
  Write-Output ("FAILED: " + $_.Exception.Message)
}