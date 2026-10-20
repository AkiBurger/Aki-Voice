using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace AkiBurgerVoice
{
    // ============================================================
    //  AkiBurger Voice · 启动器 v4（アニメ・ゲーム HOME）
    //  视觉规范：design-system/akiburger-voice/MASTER-v3.md
    //  素材：scene-studio + char-idle/thinking/happy/sad（本地原创）
    //  原则：静态优先（仅状态灯呼吸 / 进度流光 / 320ms 启动 wipe）
    //  功能：完全保留旧版启动流程（端口/路径/命令未改）
    // ============================================================
    public class Launcher : Form
    {
        // ===== 原有配置（保持端口/路径/命令不变） =====
        const string PROJECT_ROOT = @"D:\Dev\projects\voice-studio";
        const string AI_ROOT = @"D:\Dev\ai";
        const string FFMPEG_BIN = @"D:\Dev\tools\ffmpeg\bin";
        const string ENGINE_URL = "http://127.0.0.1:9880";
        const string BACKEND_URL = "http://127.0.0.1:8017";
        const string PAGE_URL = "http://127.0.0.1:8017/static/index.html";
        // 界面版本：v0.3.0（与主界面一致）。config.json 的 app version 由后端维护，启动器以界面版本为准。
        const string UI_VERSION = "v0.3.0";

        // 旧版行为：就绪后自动打开浏览器并关窗。
        // v4 保持「开始使用」CTA 手动打开（MASTER-v3 底部 CTA 语义）；改 true 可恢复自动打开。
        const bool AUTO_OPEN_AFTER_READY = false;

        // ===== 窗口布局（逻辑像素，按 DPI 整体缩放） =====
        const float W = 900f;
        const float H = 560f;
        const float WINDOW_RADIUS = 22f;
        const float TITLEBAR_H = 56f;
        const float SPLASH_SECONDS = 0.36f;
        const float CHAR_FADE_SECONDS = 0.12f;

        // ===== 颜色 token（MASTER-v3 §2） =====
        static readonly Color INK = Hex("#10224A");
        static readonly Color INK_MUTED = Hex("#4A5F8C");
        static readonly Color INK_FAINT = Hex("#8296B5");
        static readonly Color LINE = Color.FromArgb(31, 16, 34, 74);
        static readonly Color BLUE = Hex("#2F7CF6");
        static readonly Color BLUE_DEEP = Hex("#1D5FD0");
        static readonly Color BLUE_MID = Hex("#6C7BFF");
        static readonly Color PINK = Hex("#FF8FC7");
        static readonly Color PINK_DEEP = Hex("#E659A2");
        static readonly Color OK = Hex("#10B981");
        static readonly Color WARN = Hex("#F59E0B");
        static readonly Color DANGER = Hex("#EF4444");
        static readonly Color WHITE = Color.White;

        // ===== 文本格式 =====
        static readonly StringFormat SfNear = MakeSf(StringAlignment.Near, StringAlignment.Near, false);
        static readonly StringFormat SfCenter = MakeSf(StringAlignment.Center, StringAlignment.Center, false);
        static readonly StringFormat SfRight = MakeSf(StringAlignment.Far, StringAlignment.Near, false);
        static readonly StringFormat SfNearEllipsis = MakeSf(StringAlignment.Near, StringAlignment.Near, true);
        static readonly StringFormat SfWrap = MakeWrapSf(StringAlignment.Near, StringAlignment.Near);

        // ===== P/Invoke =====
        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();
        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern uint GetDpiForSystem();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindow(string className, string windowName);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);
        const int WM_NCLBUTTONDOWN = 0xA1;
        const int HTCAPTION = 2;

        // ===== 状态模型 =====
        enum StepState { Idle, Checking, Ready, Warning, Failed }

        class ServiceStatus
        {
            public string Code;
            public string Name;
            public string Detail;
            public StepState State;
            public ServiceStatus(string code, string name)
            {
                Code = code;
                Name = name;
                Detail = "等待检查";
                State = StepState.Idle;
            }
        }

        // 立绘/背景状态：0 idle, 1 thinking, 2 happy, 3 sad
        enum CharState { Idle = 0, Thinking = 1, Happy = 2, Sad = 3 }

        // ===== 字段 =====
        readonly string logPath;
        readonly string statePath;
        readonly ServiceStatus[] rows;
        float S = 1f;
        float physicalScale = 1f;
        int winW, winH;
        static Mutex instanceMutex;

        FontFamily displayFamily;
        bool displayIsFallback;
        PrivateFontCollection pfc;
        IntPtr fontMem = IntPtr.Zero;
        Font fontLogo, fontSubtitle, fontStatus, fontCta, fontVersion;
        Font fontSans13, fontSans12, fontSans11, fontSans105, fontSans10;
        Font fontMono10, fontMono9;
        string fontNote = "";

        readonly Image[] bgImages = new Image[4];
        CharState curChar = CharState.Idle;
        CharState prevChar = CharState.Idle;
        float charFadeStart = -1f;

        System.Windows.Forms.Timer animTimer;
        readonly Stopwatch clock = new Stopwatch();
        bool splashDone;
        bool working;
        volatile bool pageOpened;
        string fatalTitle, fatalDetail, fatalHuman;
        float fatalAt = -1f;
        string stageNote = "正在检查运行环境…";
        string translateNote = "检查中";
        float progress = 0f;
        string versionText = UI_VERSION;

        // 布局矩形（逻辑坐标）
        RectangleF ctaRect, dataRect, closeRect, minRect, retryRect, logButtonRect;
        int hoverBtn, pressBtn;
        PointF mouseLogical;

        // QA 自截图（仅当设置 ABV_LAUNCHER_SHOT_DIR 时启用；正常使用无影响）
        readonly string shotDir;
        readonly float[] shotTimes;
        int shotIndex;
        bool readyShotDone;
        bool failureShotDone;
        bool pendingFailureShot;

        // QA 性能计时（ABV_LAUNCHER_PAINT_LOG=1 时打印到 launcher.log）
        readonly bool paintLogEnabled;
        double paintAccMs;
        int paintCount;
        double tickAccMs;
        int tickCount;
        double bgAccMs, logoAccMs, statusAccMs, bottomAccMs, errAccMs, splashAccMs;

        static readonly object logLock = new object();

        // ============================================================
        //  构造 / 生命周期
        // ============================================================
        public Launcher()
        {
            Text = "AkiBurger Voice";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            KeyPreview = true;
            BackColor = Color.FromArgb(238, 245, 255);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;

            // DPI：manifest 声明 PerMonitorV2；逻辑像素设计，绘制时整体缩放。
            AutoScaleMode = AutoScaleMode.Dpi;
            physicalScale = PhysicalDpiScale(IntPtr.Zero);
            S = EffectiveScale(physicalScale);
            AutoScaleDimensions = new SizeF(96f * physicalScale, 96f * physicalScale);
            winW = (int)Math.Round(W * S);
            winH = (int)Math.Round(H * S);
            MinimumSize = new Size((int)Math.Round(720f * S), (int)Math.Round(448f * S));
            ClientSize = new Size(winW, winH);
            ApplyRoundedRegion();

            logPath = Path.Combine(PROJECT_ROOT, "logs", "launcher.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            statePath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "AkiBurgerVoice", "window-state.txt");

            rows = new ServiceStatus[3];
            rows[0] = new ServiceStatus("01", "声音引擎");
            rows[1] = new ServiceStatus("02", "后端服务");
            rows[2] = new ServiceStatus("03", "声音模型");

            versionText = LoadVersionText();
            LoadDisplayFont();
            CreateFonts();
            RestoreWindowPosition();

            // 布局（逻辑像素）
            minRect = new RectangleF(W - 56f, 14f, 32f, 32f);
            ctaRect = new RectangleF(44f, 480f, 256f, 44f);
            dataRect = new RectangleF(316f, 482f, 160f, 40f);
            closeRect = new RectangleF(492f, 482f, 100f, 40f);
            retryRect = new RectangleF(324f, 372f, 116f, 30f);
            logButtonRect = new RectangleF(324f, 408f, 116f, 30f);

            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 40;
            animTimer.Tick += AnimTimer_Tick;

            shotDir = ReadEnv("ABV_LAUNCHER_SHOT_DIR");
            shotTimes = ParseShotTimes(ReadEnv("ABV_LAUNCHER_SHOT_TIMES"));
            paintLogEnabled = ReadEnv("ABV_LAUNCHER_PAINT_LOG") == "1";

            Log("启动器界面初始化（v4）" + (fontNote.Length > 0 ? " | " + fontNote : ""));
            Log("DPI: 布局缩放 " + S.ToString("0.##", CultureInfo.InvariantCulture)
                + "x（物理 " + physicalScale.ToString("0.##", CultureInfo.InvariantCulture)
                + "x）窗口 " + winW + "x" + winH + "，工作区 "
                + Screen.PrimaryScreen.WorkingArea.Width + "x" + Screen.PrimaryScreen.WorkingArea.Height);
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            clock.Start();
            EnsureTimer();
            StartWork();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveWindowPosition();
            if (animTimer != null) animTimer.Stop();
            base.OnFormClosing(e);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (animTimer != null) animTimer.Dispose();
                for (int i = 0; i < bgImages.Length; i++)
                {
                    if (bgImages[i] != null) { bgImages[i].Dispose(); bgImages[i] = null; }
                }
                DisposeFont(fontLogo); DisposeFont(fontSubtitle); DisposeFont(fontStatus);
                DisposeFont(fontCta); DisposeFont(fontVersion);
                DisposeFont(fontSans13); DisposeFont(fontSans12); DisposeFont(fontSans11);
                DisposeFont(fontSans105); DisposeFont(fontSans10);
                DisposeFont(fontMono10); DisposeFont(fontMono9);
                if (displayFamily != null) { displayFamily.Dispose(); displayFamily = null; }
                if (pfc != null) { pfc.Dispose(); pfc = null; }
                if (fontMem != IntPtr.Zero) { Marshal.FreeCoTaskMem(fontMem); fontMem = IntPtr.Zero; }
            }
            base.Dispose(disposing);
        }

        static void DisposeFont(Font f)
        {
            if (f != null) f.Dispose();
        }

        // ============================================================
        //  DPI 缩放（PerMonitorV2 方案）
        // ============================================================
        static float EnvironmentScaleOverride()
        {
            try
            {
                string v = Environment.GetEnvironmentVariable("ABV_LAUNCHER_SCALE");
                if (!string.IsNullOrEmpty(v))
                {
                    float f;
                    if (float.TryParse(v.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out f) && f >= 0.5f && f <= 4f)
                        return f;
                }
            }
            catch { }
            return 0f;
        }

        static float PhysicalDpiScale(IntPtr hwnd)
        {
            try
            {
                if (hwnd != IntPtr.Zero)
                {
                    uint dpi = GetDpiForWindow(hwnd);
                    if (dpi > 0) return dpi / 96f;
                }
                else
                {
                    uint dpi = GetDpiForSystem();
                    if (dpi > 0) return dpi / 96f;
                }
            }
            catch { }
            try
            {
                using (Graphics g = Graphics.FromHwnd(hwnd))
                {
                    float s = g.DpiX / 96f;
                    return s < 1f ? 1f : s;
                }
            }
            catch { }
            return 1f;
        }

        static float EffectiveScale(float physical)
        {
            float ov = EnvironmentScaleOverride();
            if (ov > 0f) return ov;
            return physical < 1f ? 1f : physical;
        }

        void ApplyScale(float scale, float physicalDpiScale)
        {
            if (scale < 0.5f) scale = 0.5f;
            if (scale > 4f) scale = 4f;
            S = scale;
            physicalScale = physicalDpiScale > 0.1f ? physicalDpiScale : scale;
            CreateFonts();
            winW = (int)Math.Round(W * S);
            winH = (int)Math.Round(H * S);
            AutoScaleDimensions = new SizeF(96f * physicalScale, 96f * physicalScale);
            MinimumSize = new Size((int)Math.Round(720f * S), (int)Math.Round(448f * S));
            ClientSize = new Size(winW, winH);
            ApplyRoundedRegion();
            // 物理尺寸变了，背景缓存需要按新尺寸重建（懒加载）
            for (int i = 0; i < bgImages.Length; i++)
            {
                if (bgImages[i] != null) { bgImages[i].Dispose(); bgImages[i] = null; }
            }
            Invalidate();
        }

        void ClampToWorkingArea()
        {
            try
            {
                Rectangle proposed = new Rectangle(Location.X, Location.Y, Math.Max(1, winW), Math.Max(1, winH));
                Screen scr = Screen.FromRectangle(proposed);
                Rectangle wa = scr.WorkingArea;
                int x = Location.X;
                int y = Location.Y;
                if (wa.Width >= winW)
                {
                    if (x + winW > wa.Right) x = wa.Right - winW;
                    if (x < wa.Left) x = wa.Left;
                }
                else x = wa.Left;
                if (wa.Height >= winH)
                {
                    if (y + winH > wa.Bottom) y = wa.Bottom - winH;
                    if (y < wa.Top) y = wa.Top;
                }
                else y = wa.Top;
                if (x != Location.X || y != Location.Y) Location = new Point(x, y);
            }
            catch { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                float ps = PhysicalDpiScale(Handle);
                float ns = EffectiveScale(ps);
                physicalScale = ps;
                if (Math.Abs(ns - S) > 0.01f || ClientSize.Width != (int)Math.Round(W * ns))
                    ApplyScale(ns, ps);
                else
                    ClampToWorkingArea();
            }
            catch { }
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            try
            {
                float ps = e.DeviceDpiNew / 96f;
                float ns = EffectiveScale(ps);
                if (IsHandleCreated)
                {
                    BeginInvoke(new Action(delegate
                    {
                        ApplyScale(ns, ps);
                        ClampToWorkingArea();
                    }));
                }
            }
            catch { }
        }

        void ApplyRoundedRegion()
        {
            using (GraphicsPath p = RoundRectPath(new RectangleF(0f, 0f, winW, winH), WINDOW_RADIUS * S))
                Region = new Region(p);
        }

        // ============================================================
        //  资源加载（字体 / 立绘背景 / 版本）
        // ============================================================
        void LoadDisplayFont()
        {
            pfc = new PrivateFontCollection();
            try
            {
                Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream("AkiBurgerVoice.ZCOOL.ttf.gz");
                if (res != null)
                {
                    using (res)
                    using (GZipStream gz = new GZipStream(res, CompressionMode.Decompress))
                    using (MemoryStream ms = new MemoryStream())
                    {
                        gz.CopyTo(ms);
                        byte[] data = ms.ToArray();
                        fontMem = Marshal.AllocCoTaskMem(data.Length);
                        Marshal.Copy(data, 0, fontMem, data.Length);
                        pfc.AddMemoryFont(fontMem, data.Length);
                        fontNote = "展示字体已加载（内置子集 " + (data.Length / 1024) + " KB）";
                    }
                }
            }
            catch (Exception ex)
            {
                fontNote = "内置展示字体加载失败: " + ex.Message;
            }

            if (pfc.Families.Length == 0)
            {
                try
                {
                    string[] candidates = new string[]
                    {
                        Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"launcher\assets\ZCOOLQingKeHuangYou-subset.ttf"),
                        Path.Combine(PROJECT_ROOT, @"launcher\assets\ZCOOLQingKeHuangYou-subset.ttf")
                    };
                    foreach (string p in candidates)
                    {
                        if (File.Exists(p)) { pfc.AddFontFile(p); fontNote = "展示字体从文件加载: " + p; break; }
                    }
                }
                catch (Exception ex)
                {
                    fontNote += " 文件回退失败: " + ex.Message;
                }
            }

            if (pfc.Families.Length > 0)
            {
                displayFamily = pfc.Families[0];
                displayIsFallback = false;
            }
            else
            {
                displayFamily = new FontFamily(PickFamily("Microsoft YaHei UI", "Microsoft YaHei"));
                displayIsFallback = true;
                fontNote += " 使用系统字体回退";
            }
        }

        void CreateFonts()
        {
            DisposeFont(fontLogo); DisposeFont(fontSubtitle); DisposeFont(fontStatus);
            DisposeFont(fontCta); DisposeFont(fontVersion);
            DisposeFont(fontSans13); DisposeFont(fontSans12); DisposeFont(fontSans11);
            DisposeFont(fontSans105); DisposeFont(fontSans10);
            DisposeFont(fontMono10); DisposeFont(fontMono9);

            FontStyle dispStyle = displayIsFallback ? FontStyle.Bold : FontStyle.Regular;
            fontLogo = new Font(displayFamily, 44f, dispStyle, GraphicsUnit.Pixel);
            fontSubtitle = new Font(displayFamily, 11.5f, dispStyle, GraphicsUnit.Pixel);
            fontStatus = new Font(displayFamily, 21f, dispStyle, GraphicsUnit.Pixel);
            fontCta = new Font(displayFamily, 26f, dispStyle, GraphicsUnit.Pixel);
            fontVersion = new Font(displayFamily, 12f, dispStyle, GraphicsUnit.Pixel);

            string sansName = PickFamily("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI");
            fontSans13 = new Font(sansName, 13f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans12 = new Font(sansName, 12f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans11 = new Font(sansName, 11f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans105 = new Font(sansName, 10.5f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans10 = new Font(sansName, 10f, FontStyle.Regular, GraphicsUnit.Pixel);

            string monoName = PickFamily("Cascadia Mono", "Consolas", "Microsoft YaHei UI");
            fontMono10 = new Font(monoName, 10f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontMono9 = new Font(monoName, 9f, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        static string PickFamily(params string[] names)
        {
            foreach (string name in names)
            {
                try
                {
                    using (FontFamily ff = new FontFamily(name)) return name;
                }
                catch { }
            }
            return FontFamily.GenericSansSerif.Name;
        }

        Image EnsureBg(CharState state)
        {
            int idx = (int)state;
            if (bgImages[idx] != null) return bgImages[idx];
            string resName = "AkiBurgerVoice.bg." + state.ToString().ToLowerInvariant() + ".jpg";
            try
            {
                Stream res = Assembly.GetExecutingAssembly().GetManifestResourceStream(resName);
                if (res != null)
                {
                    using (res)
                    using (MemoryStream ms = new MemoryStream())
                    {
                        res.CopyTo(ms);
                        ms.Position = 0;
                        using (Image src = Image.FromStream(ms))
                        {
                            int tw = Math.Max(1, winW);
                            int th = Math.Max(1, winH);
                            if (src.Width == tw && src.Height == th)
                            {
                                bgImages[idx] = new Bitmap(src);
                            }
                            else
                            {
                                // 预缩放到物理尺寸：之后每帧都是 1:1 贴图，避免高质量重采样占满 CPU
                                Bitmap scaled = new Bitmap(tw, th, PixelFormat.Format32bppPArgb);
                                using (Graphics sg = Graphics.FromImage(scaled))
                                {
                                    sg.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                    sg.PixelOffsetMode = PixelOffsetMode.HighQuality;
                                    sg.DrawImage(src, new Rectangle(0, 0, tw, th));
                                }
                                bgImages[idx] = scaled;
                            }
                        }
                    }
                    return bgImages[idx];
                }
            }
            catch (Exception ex)
            {
                Log("立绘背景加载失败(" + resName + "): " + ex.Message);
            }
            Bitmap fallback = new Bitmap(Math.Max(1, winW), Math.Max(1, winH));
            using (Graphics g = Graphics.FromImage(fallback))
            using (LinearGradientBrush b = new LinearGradientBrush(new Rectangle(0, 0, fallback.Width, fallback.Height), Color.FromArgb(238, 245, 255), Color.FromArgb(255, 226, 240), 0f))
                g.FillRectangle(b, 0, 0, fallback.Width, fallback.Height);
            bgImages[idx] = fallback;
            return fallback;
        }

        string LoadVersionText()
        {
            return UI_VERSION;
        }

        // ============================================================
        //  窗口位置记忆
        // ============================================================
        void RestoreWindowPosition()
        {
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int x = wa.X + (wa.Width - winW) / 2;
            int y = wa.Y + (wa.Height - winH) / 2;
            try
            {
                if (File.Exists(statePath))
                {
                    string[] parts = File.ReadAllText(statePath).Split(',');
                    if (parts.Length == 2)
                    {
                        int sx = int.Parse(parts[0].Trim());
                        int sy = int.Parse(parts[1].Trim());
                        Rectangle r = new Rectangle(sx, sy, winW, winH);
                        foreach (Screen sc in Screen.AllScreens)
                        {
                            Rectangle inter = Rectangle.Intersect(sc.WorkingArea, r);
                            if (inter.Width > 200 && inter.Height > 120) { x = sx; y = sy; break; }
                        }
                    }
                }
            }
            catch { }
            Location = new Point(x, y);
            ClampToWorkingArea();
        }

        void SaveWindowPosition()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(statePath));
                File.WriteAllText(statePath, Location.X + "," + Location.Y, Encoding.UTF8);
            }
            catch { }
        }

        // ============================================================
        //  日志 / UI 线程辅助 / 状态
        // ============================================================
        void Log(string msg)
        {
            try
            {
                lock (logLock)
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
        }

        void UI(Action action)
        {
            try
            {
                if (IsDisposed || !IsHandleCreated) return;
                if (InvokeRequired) BeginInvoke(action);
                else action();
            }
            catch { }
        }

        void SetRow(int index, StepState state, string detail)
        {
            UI(delegate
            {
                ServiceStatus row = rows[index];
                row.State = state;
                if (detail != null) row.Detail = detail;
                UpdateCharState();
                EnsureTimer();
                Invalidate();
            });
        }

        void SetStage(string note)
        {
            UI(delegate { stageNote = note ?? ""; EnsureTimer(); Invalidate(); });
        }

        void SetTranslate(string note)
        {
            UI(delegate { translateNote = note ?? ""; Invalidate(); });
        }

        bool AnyChecking()
        {
            for (int i = 0; i < rows.Length; i++)
                if (rows[i].State == StepState.Checking) return true;
            return false;
        }

        bool LaunchEnabled
        {
            get
            {
                if (fatalTitle != null) return false;
                bool engineOk = rows[0].State == StepState.Ready;
                bool backendOk = rows[1].State == StepState.Ready;
                bool modelDone = rows[2].State == StepState.Ready || rows[2].State == StepState.Warning;
                return engineOk && backendOk && modelDone;
            }
        }

        CharState DesiredChar()
        {
            if (fatalTitle != null) return CharState.Sad;
            if (AnyChecking() || working) return CharState.Thinking;
            if (LaunchEnabled) return CharState.Happy;
            return CharState.Idle;
        }

        void UpdateCharState()
        {
            CharState desired = DesiredChar();
            if (desired == curChar) return;
            EnsureBg(desired);
            prevChar = curChar;
            curChar = desired;
            charFadeStart = (float)clock.Elapsed.TotalSeconds;
        }

        float TargetProgress()
        {
            if (fatalTitle != null) return progress;
            float p = 4f;
            if (rows[0].State == StepState.Ready) p = 35f;
            else if (rows[0].State == StepState.Checking) p = 14f;
            if (rows[2].State == StepState.Ready || rows[2].State == StepState.Warning) p = 70f;
            else if (rows[2].State == StepState.Checking) p = 48f;
            if (rows[1].State == StepState.Ready) p = 100f;
            else if (rows[1].State == StepState.Checking) p = 84f;
            return p;
        }

        void EnsureTimer()
        {
            if (animTimer == null) return;
            float t = (float)clock.Elapsed.TotalSeconds;
            bool fade = charFadeStart >= 0f && t - charFadeStart < CHAR_FADE_SECONDS + 0.05f;
            int interval;
            if (!splashDone || fade) interval = 40;
            else if (AnyChecking() || working || progress < TargetProgress() - 0.5f || pendingFailureShot) interval = 120;
            else if (hoverBtn == 1 && LaunchEnabled) interval = 40;
            else
            {
                // 静态优先：就绪/失败后停止定时器（状态灯保持最后亮度，不再持续重绘）
                if (animTimer.Enabled) animTimer.Stop();
                return;
            }
            if (animTimer.Interval != interval) animTimer.Interval = interval;
            if (!animTimer.Enabled) animTimer.Start();
        }

        // 只重绘会动的区域（状态灯/进度/悬停流光），保持静态优先与低 CPU
        void InvalidateDynamic()
        {
            float t = (float)clock.Elapsed.TotalSeconds;
            if (!splashDone || (charFadeStart >= 0f && t - charFadeStart < CHAR_FADE_SECONDS + 0.05f))
            {
                Invalidate();
                return;
            }
            InvalidateRectLogical(56f, 136f, 56f, 168f);   // 三盏呼吸灯
            InvalidateRectLogical(40f, 294f, 404f, 46f);   // 步骤文案/百分比/进度条
            if (hoverBtn == 1 && LaunchEnabled) InvalidateRectLogical(38f, 468f, 272f, 68f); // CTA 流光
        }

        void InvalidateRectLogical(float x, float y, float w, float h)
        {
            Invalidate(new Rectangle(
                (int)Math.Floor(x * S) - 2,
                (int)Math.Floor(y * S) - 2,
                (int)Math.Ceiling(w * S) + 4,
                (int)Math.Ceiling(h * S) + 4));
        }

        void AnimTimer_Tick(object sender, EventArgs e)
        {
            Stopwatch tickSw = paintLogEnabled ? Stopwatch.StartNew() : null;
            float t = (float)clock.Elapsed.TotalSeconds;
            if (!splashDone && t > SPLASH_SECONDS) splashDone = true;
            if (charFadeStart >= 0f && t - charFadeStart > CHAR_FADE_SECONDS + 0.15f) charFadeStart = -1f;

            float target = TargetProgress();
            if (progress < target) progress = Math.Min(target, progress + Math.Max(0.7f, (target - progress) * 0.16f));
            else if (progress > target + 0.5f) progress = target;

            EnsureTimer();
            InvalidateDynamic();

            if (shotDir != null && shotIndex < shotTimes.Length && t >= shotTimes[shotIndex])
            {
                SaveSelfShot(t, shotIndex);
                shotIndex++;
            }
            // 事件截图：就绪 / 失败（供验收，不依赖固定延时）
            if (shotDir != null)
            {
                if (!readyShotDone && splashDone && progress >= 99.5f && LaunchEnabled)
                {
                    readyShotDone = true;
                    SaveSelfShotNamed("ready");
                }
                if (!failureShotDone && fatalTitle != null && t - fatalAt > 0.30f)
                {
                    failureShotDone = true;
                    pendingFailureShot = false;
                    SaveSelfShotNamed("failure");
                }
            }
            if (tickSw != null)
            {
                tickSw.Stop();
                tickAccMs += tickSw.Elapsed.TotalMilliseconds;
                tickCount++;
                if (tickCount >= 20)
                {
                    Log("PERF tick avg " + (tickAccMs / tickCount).ToString("0.00") + "ms (interval " + animTimer.Interval + "ms)");
                    tickAccMs = 0; tickCount = 0;
                }
            }
        }

        // ============================================================
        //  启动流程（逻辑与旧版一致，仅状态显示/立绘切换）
        // ============================================================
        void StartWork()
        {
            if (working) return;
            working = true;
            UI(delegate
            {
                fatalTitle = null;
                fatalDetail = null;
                fatalHuman = null;
                fatalAt = -1f;
                for (int i = 0; i < rows.Length; i++)
                {
                    rows[i].State = StepState.Idle;
                    rows[i].Detail = "等待检查";
                }
                stageNote = "正在检查运行环境…";
                translateNote = "检查中";
                progress = 4f;
                UpdateCharState();
                EnsureTimer();
                Invalidate();
            });
            Thread t = new Thread(Work);
            t.IsBackground = true;
            t.Start();
        }

        void Work()
        {
            try
            {
                Log("=== 启动器开始 ===");
                SetRow(0, StepState.Checking, "检查安装目录…");

                string sovitsRoot = FindSovitsRoot();
                if (sovitsRoot == null)
                {
                    SetRow(0, StepState.Failed, "未找到 GPT-SoVITS 目录");
                    Fail("找不到 GPT-SoVITS 目录", @"期望在 " + AI_ROOT + @" 下找到 02_GPT-SoVITS_* 文件夹");
                    return;
                }
                string sovitsPy = Path.GetFullPath(Path.Combine(sovitsRoot, @"..\.venv\Scripts\python.exe"));
                Log("GPT-SoVITS: " + sovitsRoot);
                Log("python: " + sovitsPy);

                if (!File.Exists(sovitsPy))
                {
                    SetRow(0, StepState.Failed, "Python 环境缺失");
                    Fail("找不到 Python 运行环境", sovitsPy);
                    return;
                }

                // ---------- 1. 引擎 ----------
                if (PortListening(9880))
                {
                    Log("引擎已在运行");
                    SetRow(0, StepState.Checking, "已检测到引擎 · 等待响应…");
                }
                else
                {
                    SetStage("正在启动声音引擎… 首次加载模型需要 1~3 分钟，请耐心等待");
                    SetRow(0, StepState.Checking, "正在启动声音引擎…");
                    StartHidden(sovitsRoot, sovitsPy, "api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml", "engine.log");
                }

                SetStage("等待声音引擎就绪… 首次加载模型需要 1~3 分钟");
                if (!WaitHttp(ENGINE_URL + "/docs", 240))
                {
                    SetRow(0, StepState.Failed, "启动超时");
                    Fail("声音引擎启动超时", "详见 logs\\engine.log（可能是显存不足或依赖缺失）");
                    return;
                }
                Log("引擎就绪");
                SetRow(0, StepState.Ready, "127.0.0.1:9880");

                // ---------- 2. 挂载训练好的声音模型 ----------
                SetRow(2, StepState.Checking, "扫描训练权重…");
                SetStage("加载声音模型…");
                TryAttachWeights();

                // ---------- 2.5 翻译服务（可选，有就用质量更好的 Qwen）----------
                if (!PortListening(11434))
                {
                    SetStage("启动翻译服务（可选）… 让中→日翻译更自然");
                    StartOllama();
                    SetTranslate("内置模型");
                }
                else
                {
                    Log("翻译服务已在运行（会优先用 Qwen 翻译）");
                    SetTranslate("Qwen 在线");
                }

                // ---------- 3. 后端 ----------
                if (PortListening(8017))
                {
                    Log("后端已在运行");
                    SetRow(1, StepState.Checking, "已检测到后端 · 等待响应…");
                }
                else
                {
                    SetStage("正在启动后端服务…");
                    SetRow(1, StepState.Checking, "正在启动后端服务…");
                    StartHidden(PROJECT_ROOT, sovitsPy, @"src\backend\app.py", "backend.log");
                }

                SetStage("等待后端服务就绪…");
                if (!WaitHttp(BACKEND_URL + "/api/health", 60))
                {
                    SetRow(1, StepState.Failed, "健康检查超时");
                    Fail("后端服务启动超时", "详见 logs\\backend.log");
                    return;
                }
                Log("后端就绪");
                SetRow(1, StepState.Ready, "127.0.0.1:8017");

                // ---------- 4. 就绪 ----------
                SetStage("全部服务就绪 · 点击「开始使用」打开界面");
                Log("启动流程完成，等待开始使用");
                bool autoOpen = AUTO_OPEN_AFTER_READY;
                if (autoOpen && !pageOpened) OpenPage();
            }
            catch (Exception ex)
            {
                Log("异常: " + ex);
                Fail("启动失败", ex.Message);
            }
            finally
            {
                working = false;
                UI(delegate { UpdateCharState(); EnsureTimer(); Invalidate(); });
            }
        }

        void Fail(string title, string detail)
        {
            Log("失败: " + title + " | " + detail);
            UI(delegate
            {
                fatalTitle = title;
                fatalDetail = detail;
                fatalHuman = Humanize(title, detail);
                fatalAt = (float)clock.Elapsed.TotalSeconds;
                stageNote = "启动失败，可重试或查看日志。";
                UpdateCharState();
                EnsureTimer();
                Invalidate();
                if (shotDir != null && !failureShotDone) pendingFailureShot = true;
            });
        }

        static string Humanize(string title, string detail)
        {
            if (title == "找不到 GPT-SoVITS 目录")
                return "没找到声音引擎目录，请确认 D:\\Dev\\ai 下存在 02_GPT-SoVITS_* 文件夹。";
            if (title == "找不到 Python 运行环境")
                return "声音引擎的 Python 环境不完整，请检查 .venv\\Scripts\\python.exe 是否存在。";
            if (title == "声音引擎启动超时")
                return "声音引擎没有按时就绪，可能是显存不足或依赖缺失，打开日志看具体原因。";
            if (title == "后端服务启动超时")
                return "后端服务没有按时就绪，可能是端口 8017 被占用，打开日志看具体原因。";
            if (title == "启动失败")
                return "启动过程中出现异常：" + detail;
            return title + "：" + detail;
        }

        // ===== 以下为旧版原样保留的底层逻辑（端口/路径/命令/超时均未改动） =====
        string FindSovitsRoot()
        {
            try
            {
                foreach (var d in Directory.GetDirectories(AI_ROOT, "02_GPT-SoVITS_*"))
                {
                    var g = Path.Combine(d, "GPT-SoVITS");
                    if (File.Exists(Path.Combine(g, "api_v2.py"))) return g;
                }
            }
            catch (Exception ex) { Log("查找目录失败: " + ex.Message); }
            return null;
        }

        void StartHidden(string workDir, string exe, string args, string logName)
        {
            var logFile = Path.Combine(PROJECT_ROOT, "logs", logName);
            var psi = new ProcessStartInfo();
            psi.FileName = "cmd.exe";
            psi.Arguments = "/c \"\"" + exe + "\" " + args + " > \"" + logFile + "\" 2>&1\"";
            psi.WorkingDirectory = workDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            try
            {
                psi.EnvironmentVariables["PATH"] = FFMPEG_BIN + ";" + Environment.GetEnvironmentVariable("PATH");
                psi.EnvironmentVariables["HF_ENDPOINT"] = "https://hf-mirror.com";
                psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
            }
            catch { }
            Log("启动: " + exe + " " + args);
            Process.Start(psi);
        }

        void StartOllama()
        {
            try
            {
                string exe = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    @"Programs\Ollama\ollama app.exe");
                if (!File.Exists(exe))
                {
                    Log("没装 Ollama，翻译将用内置小模型（不影响使用）");
                    return;
                }
                var psi = new ProcessStartInfo
                {
                    FileName = exe,
                    UseShellExecute = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                };
                Process.Start(psi);
                Log("已启动 Ollama（隐藏窗口）");
            }
            catch (Exception ex)
            {
                Log("启动 Ollama 失败（翻译用内置小模型）: " + ex.Message);
            }
        }

        bool PortListening(int port)
        {
            try
            {
                using (var c = new System.Net.Sockets.TcpClient())
                {
                    var r = c.BeginConnect("127.0.0.1", port, null, null);
                    if (!r.AsyncWaitHandle.WaitOne(500)) return false;
                    c.EndConnect(r);
                    return true;
                }
            }
            catch { return false; }
        }

        bool WaitHttp(string url, int seconds)
        {
            var deadline = DateTime.Now.AddSeconds(seconds);
            while (DateTime.Now < deadline)
            {
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.Timeout = 2000;
                    req.ReadWriteTimeout = 2000;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    {
                        if ((int)resp.StatusCode == 200) return true;
                    }
                }
                catch { }
                Thread.Sleep(1500);
            }
            return false;
        }

        string FindWeight(string dir, string pattern)
        {
            try
            {
                if (!Directory.Exists(dir)) return null;
                var files = Directory.GetFiles(dir, pattern);
                if (files.Length == 0) return null;
                Array.Sort(files, (a, b) => File.GetLastWriteTime(b).CompareTo(File.GetLastWriteTime(a)));
                return Path.GetFileName(files[0]);
            }
            catch { return null; }
        }

        void TryAttachWeights()
        {
            try
            {
                string sovitsDir = Path.Combine(FindSovitsRoot(), "SoVITS_weights_v2Pro");
                string gptDir = Path.Combine(FindSovitsRoot(), "GPT_weights_v2Pro");
                string sovitsFile = FindWeight(sovitsDir, "*.pth");
                string gptFile = FindWeight(gptDir, "*.ckpt");
                string mounted = "";

                if (sovitsFile != null)
                {
                    SetRow(2, StepState.Checking, sovitsFile);
                    HttpGet(ENGINE_URL + "/set_sovits_weights?weights_path=SoVITS_weights_v2Pro/" + sovitsFile, 120);
                    Log("SoVITS 已挂载: " + sovitsFile);
                    mounted = sovitsFile;
                }
                if (gptFile != null)
                {
                    SetRow(2, StepState.Checking, gptFile);
                    HttpGet(ENGINE_URL + "/set_gpt_weights?weights_path=GPT_weights_v2Pro/" + gptFile, 120);
                    Log("GPT 已挂载: " + gptFile);
                    mounted = mounted.Length > 0 ? mounted + " + " + gptFile : gptFile;
                }
                if (sovitsFile == null && gptFile == null)
                {
                    Log("没有找到训练权重，将使用预训练底模");
                    SetRow(2, StepState.Warning, "未找到训练权重 · 使用预训练底模");
                }
                else
                {
                    SetRow(2, StepState.Ready, mounted);
                }
            }
            catch (Exception ex)
            {
                Log("挂载权重失败（将使用默认音色）: " + ex.Message);
                SetRow(2, StepState.Warning, "挂载失败 · 使用默认音色");
            }
        }

        string HttpGet(string url, int timeoutSec)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeoutSec * 1000;
            req.ReadWriteTimeout = timeoutSec * 1000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }

        // ============================================================
        //  UI 动作
        // ============================================================
        void OpenPage()
        {
            try
            {
                Process.Start(new ProcessStartInfo(PAGE_URL) { UseShellExecute = true });
                pageOpened = true;
                Log("已打开浏览器");
            }
            catch (Exception ex)
            {
                Log("打开浏览器失败: " + ex.Message);
                stageNote = "打开浏览器失败，请手动访问 127.0.0.1:8017";
                UI(delegate { Invalidate(); });
            }
        }

        void OpenDataDir()
        {
            string dir = Path.Combine(PROJECT_ROOT, "data");
            if (!Directory.Exists(dir)) dir = PROJECT_ROOT;
            try
            {
                Process.Start("explorer.exe", "\"" + dir + "\"");
                Log("打开数据目录: " + dir);
            }
            catch (Exception ex)
            {
                Log("打开数据目录失败: " + ex.Message);
            }
        }

        void OpenLog()
        {
            try
            {
                if (!File.Exists(logPath)) File.WriteAllText(logPath, "", Encoding.UTF8);
                Process.Start("notepad.exe", "\"" + logPath + "\"");
                Log("打开日志: " + logPath);
            }
            catch (Exception ex)
            {
                Log("打开日志失败: " + ex.Message);
            }
        }

        void Retry()
        {
            if (working) return;
            StartWork();
        }

        void CloseLauncher()
        {
            Log("关闭启动器（后台服务保持运行）");
            Close();
        }

        void MinimizeWindow()
        {
            WindowState = FormWindowState.Minimized;
        }

        // ============================================================
        //  输入
        // ============================================================
        PointF ToLogical(Point p)
        {
            return new PointF(p.X / S, p.Y / S);
        }

        int HitTest(PointF p)
        {
            if (minRect.Contains(p)) return 4;
            if (fatalTitle != null && retryRect.Contains(p)) return 5;
            if (fatalTitle != null && logButtonRect.Contains(p)) return 6;
            if (ctaRect.Contains(p)) return 1;
            if (dataRect.Contains(p)) return 2;
            if (closeRect.Contains(p)) return 3;
            return 0;
        }

        bool ButtonActive(int btn)
        {
            if (btn == 1) return LaunchEnabled;
            if (btn == 5 || btn == 6) return fatalTitle != null;
            return true;
        }

        void ActivateButton(int btn)
        {
            switch (btn)
            {
                case 1: if (LaunchEnabled) OpenPage(); break;
                case 2: OpenDataDir(); break;
                case 3: CloseLauncher(); break;
                case 4: MinimizeWindow(); break;
                case 5: Retry(); break;
                case 6: OpenLog(); break;
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            mouseLogical = ToLogical(e.Location);
            int h = HitTest(mouseLogical);
            if (h != hoverBtn)
            {
                hoverBtn = h;
                Cursor = (h != 0 && ButtonActive(h)) ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hoverBtn = 0;
            pressBtn = 0;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            PointF p = ToLogical(e.Location);
            if (p.Y < TITLEBAR_H && !minRect.Contains(p))
            {
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                return;
            }
            pressBtn = HitTest(p);
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            PointF p = ToLogical(e.Location);
            int hit = HitTest(p);
            int pressed = pressBtn;
            pressBtn = 0;
            if (pressed != 0 && pressed == hit) ActivateButton(pressed);
            Invalidate();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                CloseLauncher();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Enter)
            {
                if (fatalTitle != null) Retry();
                else if (LaunchEnabled) OpenPage();
                e.Handled = true;
            }
        }

        // ============================================================
        //  绘制
        // ============================================================
        protected override void OnPaint(PaintEventArgs e)
        {
            Stopwatch paintSw = paintLogEnabled ? Stopwatch.StartNew() : null;
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.Default;
            g.CompositingQuality = CompositingQuality.Default;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            float t = (float)clock.Elapsed.TotalSeconds;

            // 背景按物理尺寸 1:1 贴图（预缩放），不做每帧重采样
            Stopwatch secSw = paintLogEnabled ? Stopwatch.StartNew() : null;
            using (GraphicsPath roundP = RoundRectPath(new RectangleF(0f, 0f, winW, winH), WINDOW_RADIUS * S))
            {
                GraphicsState bgState = g.Save();
                g.SetClip(roundP);
                DrawBackgroundPhysical(g, t);
                g.Restore(bgState);
            }
            if (secSw != null) { secSw.Stop(); bgAccMs += secSw.Elapsed.TotalMilliseconds; }

            GraphicsState st = g.Save();
            g.ScaleTransform(S, S);
            using (GraphicsPath round = RoundRectPath(new RectangleF(0f, 0f, W, H), WINDOW_RADIUS))
            {
                g.SetClip(round);
                DrawScene(g, t);
            }
            g.Restore(st);

            if (paintSw != null)
            {
                paintSw.Stop();
                paintAccMs += paintSw.Elapsed.TotalMilliseconds;
                paintCount++;
                if (paintCount >= 10)
                {
                    Log("PERF paint avg " + (paintAccMs / paintCount).ToString("0.00") + "ms (" + winW + "x" + winH + ")"
                        + " | bg=" + (bgAccMs / paintCount).ToString("0.0")
                        + " logo=" + (logoAccMs / paintCount).ToString("0.0")
                        + " status=" + (statusAccMs / paintCount).ToString("0.0")
                        + " bottom=" + (bottomAccMs / paintCount).ToString("0.0")
                        + " err=" + (errAccMs / paintCount).ToString("0.0")
                        + " splash=" + (splashAccMs / paintCount).ToString("0.0"));
                    paintAccMs = 0; paintCount = 0;
                    bgAccMs = 0; logoAccMs = 0; statusAccMs = 0; bottomAccMs = 0; errAccMs = 0; splashAccMs = 0;
                }
            }
        }

        void DrawBackgroundPhysical(Graphics g, float t)
        {
            Image cur = EnsureBg(curChar);
            bool fading = prevChar != curChar && charFadeStart >= 0f;
            if (fading)
            {
                float p = Clamp01((t - charFadeStart) / CHAR_FADE_SECONDS);
                Image prev = EnsureBg(prevChar);
                DrawImageAlphaPhysical(g, prev, 1f - p);
                DrawImageAlphaPhysical(g, cur, p);
            }
            else
            {
                g.DrawImageUnscaled(cur, 0, 0);
            }
        }

        void DrawImageAlphaPhysical(Graphics g, Image img, float alpha)
        {
            if (alpha <= 0.001f) return;
            if (alpha >= 0.999f)
            {
                g.DrawImageUnscaled(img, 0, 0);
                return;
            }
            using (ImageAttributes ia = new ImageAttributes())
            {
                ColorMatrix cm = new ColorMatrix();
                cm.Matrix33 = alpha;
                ia.SetColorMatrix(cm);
                Rectangle dest = new Rectangle(0, 0, winW, winH);
                g.DrawImage(img, dest, 0f, 0f, img.Width, img.Height, GraphicsUnit.Pixel, ia);
            }
        }

        void DrawScene(Graphics g, float t)
        {
            float uiAlpha = splashDone ? 1f : Intro(t, 0.10f, 0.22f);
            if (uiAlpha > 0.01f)
            {
                Stopwatch sw = paintLogEnabled ? Stopwatch.StartNew() : null;
                DrawLogoBlock(g, uiAlpha);
                if (sw != null) { sw.Stop(); logoAccMs += sw.Elapsed.TotalMilliseconds; sw = Stopwatch.StartNew(); }
                DrawStatusPanel(g, uiAlpha);
                if (sw != null) { sw.Stop(); statusAccMs += sw.Elapsed.TotalMilliseconds; sw = Stopwatch.StartNew(); }
                DrawBottomBar(g, uiAlpha);
                if (sw != null) { sw.Stop(); bottomAccMs += sw.Elapsed.TotalMilliseconds; sw = Stopwatch.StartNew(); }
                if (fatalTitle != null) DrawErrorCard(g, uiAlpha);
                if (sw != null) { sw.Stop(); errAccMs += sw.Elapsed.TotalMilliseconds; sw = null; }
                DrawTitlebarButtons(g, uiAlpha);
            }
            Stopwatch sw2 = paintLogEnabled ? Stopwatch.StartNew() : null;
            DrawSplashOverlay(g, t);
            if (sw2 != null) { sw2.Stop(); splashAccMs += sw2.Elapsed.TotalMilliseconds; }
        }

        void DrawLogoBlock(Graphics g, float a)
        {
            RectangleF mark = new RectangleF(30f, 20f, 20f, 20f);
            using (GraphicsPath mp = RoundRectPath(mark, 6f))
            using (LinearGradientBrush b = new LinearGradientBrush(mark, A(BLUE, a), A(PINK_DEEP, a), 45f))
                g.FillPath(b, mp);
            using (SolidBrush b = new SolidBrush(A(WHITE, 0.75f * a)))
                g.FillEllipse(b, mark.X + 6f, mark.Y + 6f, 8f, 8f);

            RectangleF lr = new RectangleF(56f, 2f, 420f, 62f);
            DrawTextGlow(g, "AkiBurger", fontLogo, lr, A(WHITE, 0.32f * a));
            using (LinearGradientBrush b = MakeGradient(lr, 0f,
                new Color[] { A(BLUE_DEEP, a), A(BLUE_MID, a), A(PINK_DEEP, a) },
                new float[] { 0f, 0.5f, 1f }))
                g.DrawString("AkiBurger", fontLogo, b, lr, SfNear);

            DrawTrackedShadow(g, "VOICE DUBBING STUDIO", fontSubtitle, A(INK_MUTED, a), 60f, 56f, 3.0f, a);
            float subW = TrackedWidth(g, "VOICE DUBBING STUDIO", fontSubtitle, 3.0f);
            float px = 60f + subW + 12f;
            if (px + 66f < W - 120f)
            {
                RectangleF pill = new RectangleF(px, 52f, 64f, 20f);
                using (GraphicsPath p = RoundRectPath(pill, 10f))
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(190 * a), 255, 255, 255))) g.FillPath(b, p);
                    using (Pen pen = new Pen(A(WHITE, 0.85f * a), 1f)) g.DrawPath(pen, p);
                }
                DrawText(g, versionText, fontVersion, A(BLUE_DEEP, a),
                    new RectangleF(pill.X, pill.Y + 2f, pill.Width, 18f), SfCenter);
            }
        }

        void DrawTitlebarButtons(Graphics g, float a)
        {
            bool hover = hoverBtn == 4;
            using (GraphicsPath p = RoundRectPath(minRect, 10f))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb((int)((hover ? 210 : 130) * a), 255, 255, 255))) g.FillPath(b, p);
                using (Pen pen = new Pen(A(WHITE, (hover ? 0.95f : 0.6f) * a), 1f)) g.DrawPath(pen, p);
            }
            using (Pen pen = new Pen(A(INK, (hover ? 0.95f : 0.7f) * a), 2f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawLine(pen, minRect.X + 10f, minRect.Y + 16f, minRect.X + 22f, minRect.Y + 16f);
            }
        }

        void DrawStatusPanel(Graphics g, float a)
        {
            RectangleF panel = new RectangleF(28f, 92f, 426f, 262f);
            GlassPanel(g, panel, 20f, (int)(214 * a));

            using (SolidBrush b = new SolidBrush(A(PINK_DEEP, 0.95f * a)))
                g.FillRectangle(b, 48f, 110f, 7f, 7f);
            DrawTracked(g, "SYSTEM STATUS", fontMono10, A(INK_MUTED, 0.95f * a), 64f, 105f, 2.4f);
            DrawText(g, "启动检查", fontSans11, A(INK_MUTED, 0.9f * a), new RectangleF(300f, 104f, 132f, 16f), SfRight);
            using (Pen pen = new Pen(A(LINE, a), 1f)) g.DrawLine(pen, 48f, 126f, 434f, 126f);

            for (int i = 0; i < rows.Length; i++)
                DrawStatusRow(g, rows[i], i, 140f + i * 54f, a);

            DrawText(g, stageNote, fontSans105, A(INK_MUTED, 0.95f * a),
                new RectangleF(48f, 302f, 310f, 16f), SfNearEllipsis);
            DrawText(g, ((int)Math.Round(progress)).ToString() + "%", fontMono10, A(BLUE_DEEP, a),
                new RectangleF(374f, 302f, 60f, 16f), SfRight);
            DrawProgressBar(g, new RectangleF(48f, 324f, 386f, 8f), a);
            if (fatalTitle == null)
            {
                DrawText(g, "翻译 " + translateNote, fontSans10, A(INK_FAINT, 0.95f * a),
                    new RectangleF(300f, 333f, 134f, 14f), SfRight);
            }
        }

        void DrawStatusRow(Graphics g, ServiceStatus row, int index, float y, float a)
        {
            Color stateColor = StateColor(row.State);
            DrawTracked(g, row.Code, fontMono9, A(INK_FAINT, 0.9f * a), 48f, y + 4f, 1.4f);
            DrawLamp(g, 80f, y + 19f, stateColor, row.State, a);
            DrawText(g, row.Name, fontStatus, A(INK, a), 98f, y + 1f);
            DrawText(g, StateLabel(row.State), fontSans12, A(stateColor, a),
                new RectangleF(320f, y + 6f, 114f, 16f), SfRight);
            DrawText(g, row.Detail, fontSans105, A(INK_MUTED, 0.92f * a),
                new RectangleF(98f, y + 29f, 300f, 16f), SfNearEllipsis);
            if (index < 2)
            {
                using (Pen pen = new Pen(A(LINE, 0.8f * a), 1f)) g.DrawLine(pen, 48f, y + 51f, 434f, y + 51f);
            }
        }

        void DrawLamp(Graphics g, float cx, float cy, Color color, StepState state, float a)
        {
            float t = (float)clock.Elapsed.TotalSeconds;
            float pulse;
            if (state == StepState.Idle) pulse = 0.15f;
            else if (state == StepState.Checking || state == StepState.Failed)
                pulse = 0.5f + 0.5f * (float)Math.Sin(t * 3.2f);
            else pulse = 0.5f + 0.5f * (float)Math.Sin(t * 1.1f);

            for (int i = 3; i >= 1; i--)
            {
                float r = 5f + i * 3.8f + pulse * 1.2f;
                int al = state == StepState.Idle ? (int)(14 * a) : (int)((16f + 20f * pulse) * a);
                if (al < 0) al = 0;
                if (al > 255) al = 255;
                using (SolidBrush b = new SolidBrush(Color.FromArgb(al, color)))
                    g.FillEllipse(b, cx - r, cy - r, r * 2f, r * 2f);
            }
            using (SolidBrush b = new SolidBrush(A(color, a))) g.FillEllipse(b, cx - 5f, cy - 5f, 10f, 10f);
            using (SolidBrush b = new SolidBrush(A(WHITE, 0.55f * a))) g.FillEllipse(b, cx - 3f, cy - 3.4f, 3.4f, 3.4f);
        }

        void DrawProgressBar(Graphics g, RectangleF r, float a)
        {
            using (GraphicsPath track = RoundRectPath(r, r.Height / 2f))
            using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(46 * a), INK)))
                g.FillPath(b, track);

            float pct = Clamp01(progress / 100f);
            float fillW = Math.Max(r.Height, r.Width * pct);
            RectangleF fill = new RectangleF(r.X, r.Y, fillW, r.Height);
            using (GraphicsPath fp = RoundRectPath(fill, r.Height / 2f))
            {
                using (LinearGradientBrush b = MakeGradient(fill, 0f,
                    new Color[] { A(BLUE, a), A(BLUE_MID, a), A(PINK, a) },
                    new float[] { 0f, 0.55f, 1f }))
                    g.FillPath(b, fp);

                if (progress < 99.5f)
                {
                    GraphicsState st = g.Save();
                    g.SetClip(fp);
                    float phase = ((float)clock.Elapsed.TotalSeconds * 18f) % 14f;
                    using (Pen stripe = new Pen(Color.FromArgb((int)(60 * a), 255, 255, 255), 2f))
                    {
                        for (float x = fill.X - 40f + phase; x < fill.Right + 20f; x += 14f)
                            g.DrawLine(stripe, x, fill.Bottom + 2f, x + 10f, fill.Y - 2f);
                    }
                    g.Restore(st);
                }
            }
            if (progress > 1f && progress < 99.5f)
            {
                float hx = Math.Min(r.Right - 4f, r.X + r.Width * pct);
                using (SolidBrush b = new SolidBrush(A(WHITE, 0.85f * a)))
                    g.FillEllipse(b, hx - 2.5f, r.Y + 1.5f, 5f, 5f);
            }
        }

        void DrawBottomBar(Graphics g, float a)
        {
            RectangleF bar = new RectangleF(28f, 468f, 844f, 68f);
            GlassPanel(g, bar, 22f, (int)(218 * a));

            DrawCta(g, a);
            DrawSecondary(g, dataRect, "打开数据目录", 2, a);
            DrawSecondary(g, closeRect, "关闭", 3, a);

            Color st = rows[1].State == StepState.Ready ? OK
                : (rows[1].State == StepState.Checking ? WARN : INK_FAINT);
            float right = W - 44f;
            string line1 = "LOCAL · 127.0.0.1:8017";
            string line2 = "ENTER START · ESC CLOSE";
            float w1 = TrackedWidth(g, line1, fontMono9, 0.6f);
            float w2 = TrackedWidth(g, line2, fontMono9, 0.6f);
            using (SolidBrush b = new SolidBrush(A(st, 0.95f * a)))
                g.FillEllipse(b, right - w1 - 12f, 487f, 7f, 7f);
            DrawTracked(g, line1, fontMono9, A(INK_MUTED, 0.95f * a), right - w1, 484f, 0.6f);
            DrawTracked(g, line2, fontMono9, A(INK_FAINT, 0.9f * a), right - w2, 501f, 0.6f);
        }

        void DrawCta(Graphics g, float a)
        {
            bool enabled = LaunchEnabled && fatalTitle == null;
            bool hover = hoverBtn == 1;
            bool pressed = pressBtn == 1;
            float yoff = pressed ? 1.5f : (hover ? -1f : 0f);
            RectangleF r = new RectangleF(ctaRect.X, ctaRect.Y + yoff, ctaRect.Width, ctaRect.Height);

            if (enabled)
            {
                using (Pen glow = new Pen(A(PINK, (hover ? 0.30f : 0.16f) * a), 6f))
                using (GraphicsPath gp = RoundRectPath(new RectangleF(r.X - 2f, r.Y - 2f, r.Width + 4f, r.Height + 4f), r.Height / 2f))
                    g.DrawPath(glow, gp);
            }

            using (GraphicsPath p = RoundRectPath(r, r.Height / 2f))
            {
                if (enabled)
                {
                    using (LinearGradientBrush b = MakeGradient(r, 8f,
                        new Color[] { A(BLUE, a), A(BLUE_MID, a), A(PINK, a) },
                        new float[] { 0f, 0.5f, 1f }))
                        g.FillPath(b, p);
                    GraphicsState st = g.Save();
                    g.SetClip(p);
                    float cyc = ((float)clock.Elapsed.TotalSeconds % 2.6f) / 1.1f;
                    if (hover && cyc < 1f)
                    {
                        float sx = r.X - 90f + EaseOutCubic(cyc) * (r.Width + 180f);
                        using (LinearGradientBrush sb = MakeGradient(new RectangleF(sx - 45f, r.Y, 90f, r.Height), 0f,
                            new Color[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb((int)(110 * a), 255, 255, 255), Color.FromArgb(0, 255, 255, 255) },
                            new float[] { 0f, 0.5f, 1f }))
                            g.FillRectangle(sb, sx - 45f, r.Y, 90f, r.Height);
                    }
                    g.Restore(st);
                    using (Pen pen = new Pen(A(WHITE, 0.55f * a), 1.2f)) g.DrawPath(pen, p);
                    DrawText(g, "开始使用", fontCta, A(WHITE, a), new RectangleF(r.X, r.Y + (r.Height - 32f) / 2f - 1f, r.Width, 32f), SfCenter);
                }
                else
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(170 * a), 255, 255, 255))) g.FillPath(b, p);
                    using (Pen pen = new Pen(A(BLUE, 0.20f * a), 1.2f)) g.DrawPath(pen, p);
                    DrawText(g, "开始使用", fontCta, A(INK_FAINT, 0.9f * a), new RectangleF(r.X, r.Y + (r.Height - 32f) / 2f - 1f, r.Width, 32f), SfCenter);
                }
            }
        }

        void DrawSecondary(Graphics g, RectangleF rect, string text, int btn, float a)
        {
            bool hover = hoverBtn == btn;
            bool pressed = pressBtn == btn;
            float yoff = pressed ? 1.5f : (hover ? -1f : 0f);
            RectangleF r = new RectangleF(rect.X, rect.Y + yoff, rect.Width, rect.Height);
            using (GraphicsPath p = RoundRectPath(r, r.Height / 2f))
            {
                int alpha = (int)((hover ? 236 : 205) * a);
                using (SolidBrush b = new SolidBrush(Color.FromArgb(Math.Min(255, alpha), 255, 255, 255))) g.FillPath(b, p);
                Color border = hover ? BLUE : Color.FromArgb(70, 47, 124, 246);
                using (Pen pen = new Pen(A(border, (hover ? 0.75f : 0.5f) * a), 1.2f)) g.DrawPath(pen, p);
                DrawText(g, text, fontSans13, A(INK, a), r, SfCenter);
            }
        }

        void DrawErrorCard(Graphics g, float a)
        {
            float age = (float)clock.Elapsed.TotalSeconds - fatalAt;
            float slide = EaseOutCubic(Clamp01(age / 0.2f));
            RectangleF card = new RectangleF(28f, 360f + (1f - slide) * 8f, 426f, 94f);
            retryRect = new RectangleF(card.X + 296f, card.Y + 12f, 116f, 30f);
            logButtonRect = new RectangleF(card.X + 296f, card.Y + 48f, 116f, 30f);

            GlassPanel(g, card, 18f, (int)(226 * a));
            using (GraphicsPath p = RoundRectPath(new RectangleF(card.X + 8f, card.Y + 12f, 4f, card.Height - 24f), 2f))
            using (SolidBrush b = new SolidBrush(A(DANGER, 0.9f * a)))
                g.FillPath(b, p);
            DrawWarnIcon(g, card.X + 30f, card.Y + 34f, a);
            DrawText(g, fatalHuman, fontSans105, A(INK, a),
                new RectangleF(card.X + 50f, card.Y + 12f, 236f, 40f), SfWrap);
            DrawText(g, "日志 " + logPath, fontMono9, A(INK_MUTED, 0.9f * a),
                new RectangleF(card.X + 50f, card.Y + 56f, 236f, 14f), SfNearEllipsis);
            DrawSmallButton(g, retryRect, "重试", hoverBtn == 5, pressBtn == 5, a, true);
            DrawSmallButton(g, logButtonRect, "查看日志", hoverBtn == 6, pressBtn == 6, a, false);
        }

        void DrawSmallButton(Graphics g, RectangleF rect, string text, bool hover, bool pressed, float a, bool primary)
        {
            float off = (hover ? -1f : 0f) + (pressed ? 1f : 0f);
            RectangleF r = new RectangleF(rect.X, rect.Y + off, rect.Width, rect.Height);
            using (GraphicsPath p = RoundRectPath(r, 8f))
            {
                if (primary)
                {
                    using (SolidBrush b = new SolidBrush(A(hover ? BLUE_DEEP : BLUE, a))) g.FillPath(b, p);
                }
                else
                {
                    using (SolidBrush b = new SolidBrush(Color.FromArgb((int)((hover ? 240 : 210) * a), 255, 255, 255))) g.FillPath(b, p);
                    using (Pen pen = new Pen(A(hover ? BLUE : BLUE_DEEP, (hover ? 0.7f : 0.45f) * a), 1.1f)) g.DrawPath(pen, p);
                }
                DrawText(g, text, fontSans12, A(primary ? WHITE : INK, a), r, SfCenter);
            }
        }

        void DrawWarnIcon(Graphics g, float cx, float cy, float a)
        {
            PointF[] tri = new PointF[]
            {
                new PointF(cx, cy - 9f), new PointF(cx + 10f, cy + 8f), new PointF(cx - 10f, cy + 8f)
            };
            using (SolidBrush b = new SolidBrush(A(DANGER, 0.16f * a))) g.FillPolygon(b, tri);
            using (Pen pen = new Pen(A(DANGER, 0.95f * a), 1.4f))
            {
                pen.LineJoin = LineJoin.Round;
                g.DrawPolygon(pen, tri);
            }
            using (Pen pen = new Pen(A(DANGER, 0.95f * a), 1.6f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawLine(pen, cx, cy - 3f, cx, cy + 2f);
            }
            using (SolidBrush b = new SolidBrush(A(DANGER, 0.95f * a))) g.FillEllipse(b, cx - 1f, cy + 4f, 2f, 2f);
        }

        void DrawSplashOverlay(Graphics g, float t)
        {
            if (splashDone) return;
            float p = Clamp01(t / SPLASH_SECONDS);
            float e = EaseOutCubic(p);
            float x = -180f + e * (W + 360f);
            if (x - 130f >= W) return;

            float coverW = Math.Max(1f, W - x + 110f);
            PointF[] cover = new PointF[]
            {
                new PointF(x, 0f), new PointF(W, 0f), new PointF(W, H), new PointF(x - 110f, H)
            };
            using (LinearGradientBrush b = MakeGradient(new RectangleF(x - 110f, 0f, coverW, H), 0f,
                new Color[] { Color.FromArgb(252, 244, 249, 255), Color.FromArgb(252, 230, 240, 255), Color.FromArgb(252, 226, 236, 255) },
                new float[] { 0f, 0.6f, 1f }))
                g.FillPolygon(b, cover);

            PointF[] edge = new PointF[]
            {
                new PointF(x - 110f, 0f), new PointF(x, 0f), new PointF(x - 110f, H), new PointF(x - 220f, H)
            };
            using (LinearGradientBrush b = MakeGradient(new RectangleF(x - 220f, 0f, 220f, H), 0f,
                new Color[] { Color.FromArgb(0, BLUE), Color.FromArgb(150, BLUE), Color.FromArgb(200, PINK), Color.FromArgb(0, PINK) },
                new float[] { 0f, 0.45f, 0.7f, 1f }))
                g.FillPolygon(b, edge);
            using (Pen pen = new Pen(Color.FromArgb(235, 255, 255, 255), 2f))
                g.DrawLine(pen, x, 0f, x - 110f, H);
        }

        // ============================================================
        //  绘制小工具
        // ============================================================
        void GlassPanel(Graphics g, RectangleF r, float radius, int alpha)
        {
            for (int i = 3; i >= 1; i--)
            {
                using (GraphicsPath sp = RoundRectPath(
                    new RectangleF(r.X + i * 1.5f, r.Y + 5f + i * 1.5f, r.Width, r.Height), radius))
                using (SolidBrush sb = new SolidBrush(Color.FromArgb(9 + i * 4, 28, 70, 160)))
                    g.FillPath(sb, sp);
            }
            using (GraphicsPath p = RoundRectPath(r, radius))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb(ClampByte(alpha), 255, 255, 255))) g.FillPath(b, p);
                using (Pen pen = new Pen(Color.FromArgb((int)(235 * (alpha / 255f)), 255, 255, 255), 1.2f)) g.DrawPath(pen, p);
            }
            using (LinearGradientBrush b = MakeGradient(new RectangleF(r.X + radius, r.Y + 1f, Math.Max(1f, r.Width - radius * 2f), 1f), 0f,
                new Color[] { Color.FromArgb(0, 255, 255, 255), Color.FromArgb(200, 255, 255, 255), Color.FromArgb(0, 255, 255, 255) },
                new float[] { 0f, 0.5f, 1f }))
                g.FillRectangle(b, r.X + radius, r.Y + 1f, Math.Max(1f, r.Width - radius * 2f), 1f);
        }

        static int ClampByte(int v)
        {
            if (v < 0) return 0;
            if (v > 255) return 255;
            return v;
        }

        static void DrawText(Graphics g, string text, Font font, Color color, float x, float y)
        {
            if (color.A == 0) return;
            using (SolidBrush b = new SolidBrush(color)) g.DrawString(text, font, b, x, y);
        }

        static void DrawText(Graphics g, string text, Font font, Color color, RectangleF rect, StringFormat sf)
        {
            if (color.A == 0) return;
            using (SolidBrush b = new SolidBrush(color)) g.DrawString(text, font, b, rect, sf);
        }

        void DrawTextGlow(Graphics g, string text, Font font, RectangleF rect, Color glow)
        {
            using (SolidBrush b = new SolidBrush(glow))
            {
                g.DrawString(text, font, b, new RectangleF(rect.X - 1.5f, rect.Y, rect.Width, rect.Height), SfNear);
                g.DrawString(text, font, b, new RectangleF(rect.X + 1.5f, rect.Y, rect.Width, rect.Height), SfNear);
                g.DrawString(text, font, b, new RectangleF(rect.X, rect.Y - 1.5f, rect.Width, rect.Height), SfNear);
                g.DrawString(text, font, b, new RectangleF(rect.X, rect.Y + 1.5f, rect.Width, rect.Height), SfNear);
            }
        }

        static void DrawTracked(Graphics g, string text, Font font, Color color, float x, float y, float tracking)
        {
            if (color.A == 0 || text == null) return;
            using (SolidBrush b = new SolidBrush(color))
            {
                float cx = x;
                for (int i = 0; i < text.Length; i++)
                {
                    string ch = text.Substring(i, 1);
                    g.DrawString(ch, font, b, cx, y);
                    cx += g.MeasureString(ch, font).Width + tracking;
                }
            }
        }

        void DrawTrackedShadow(Graphics g, string text, Font font, Color color, float x, float y, float tracking, float a)
        {
            using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(150 * a), 255, 255, 255)))
            {
                float cx = x + 0.8f;
                for (int i = 0; i < text.Length; i++)
                {
                    string ch = text.Substring(i, 1);
                    g.DrawString(ch, font, b, cx, y + 0.8f);
                    cx += g.MeasureString(ch, font).Width + tracking;
                }
            }
            DrawTracked(g, text, font, color, x, y, tracking);
        }

        static float TrackedWidth(Graphics g, string text, Font font, float tracking)
        {
            if (text == null) return 0f;
            float w = 0f;
            for (int i = 0; i < text.Length; i++)
                w += g.MeasureString(text.Substring(i, 1), font).Width + tracking;
            return w;
        }

        static Color StateColor(StepState s)
        {
            switch (s)
            {
                case StepState.Ready: return OK;
                case StepState.Checking: return WARN;
                case StepState.Failed: return DANGER;
                case StepState.Warning: return WARN;
                default: return INK_FAINT;
            }
        }

        static string StateLabel(StepState s)
        {
            switch (s)
            {
                case StepState.Ready: return "就绪";
                case StepState.Checking: return "检查中";
                case StepState.Failed: return "失败";
                case StepState.Warning: return "注意";
                default: return "待检查";
            }
        }

        static GraphicsPath RoundRectPath(RectangleF r, float radius)
        {
            GraphicsPath p = new GraphicsPath();
            float d = Math.Min(radius * 2f, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                p.AddRectangle(r);
                return p;
            }
            p.AddArc(r.X, r.Y, d, d, 180f, 90f);
            p.AddArc(r.Right - d, r.Y, d, d, 270f, 90f);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0f, 90f);
            p.AddArc(r.X, r.Bottom - d, d, d, 90f, 90f);
            p.CloseFigure();
            return p;
        }

        static StringFormat MakeSf(StringAlignment h, StringAlignment v, bool ellipsis)
        {
            StringFormat f = new StringFormat(StringFormatFlags.NoWrap);
            f.Alignment = h;
            f.LineAlignment = v;
            if (ellipsis) f.Trimming = StringTrimming.EllipsisCharacter;
            return f;
        }

        static StringFormat MakeWrapSf(StringAlignment h, StringAlignment v)
        {
            StringFormat f = new StringFormat();
            f.Alignment = h;
            f.LineAlignment = v;
            f.Trimming = StringTrimming.EllipsisCharacter;
            return f;
        }

        static Color Hex(string hex)
        {
            return ColorTranslator.FromHtml(hex);
        }

        static Color A(Color c, float alpha)
        {
            int a = (int)Math.Round(c.A * Clamp01(alpha));
            if (a < 0) a = 0;
            if (a > 255) a = 255;
            return Color.FromArgb(a, c.R, c.G, c.B);
        }

        static float Clamp01(float v)
        {
            if (v < 0f) return 0f;
            if (v > 1f) return 1f;
            return v;
        }

        static float EaseOutCubic(float p)
        {
            float q = 1f - Clamp01(p);
            return 1f - q * q * q;
        }

        float Intro(float t, float start, float dur)
        {
            return EaseOutCubic(Clamp01((t - start) / dur));
        }

        static LinearGradientBrush MakeGradient(RectangleF rect, float angle, Color[] colors, float[] positions)
        {
            if (rect.Width < 0.1f) rect.Width = 0.1f;
            if (rect.Height < 0.1f) rect.Height = 0.1f;
            LinearGradientBrush b = new LinearGradientBrush(rect, colors[0], colors[colors.Length - 1], angle);
            if (colors.Length > 2)
            {
                ColorBlend cb = new ColorBlend(colors.Length);
                cb.Colors = colors;
                cb.Positions = positions;
                b.InterpolationColors = cb;
            }
            return b;
        }

        // ============================================================
        //  QA 自截图（不依赖桌面可见性/DWM 合成）
        // ============================================================
        static string ReadEnv(string name)
        {
            try { return Environment.GetEnvironmentVariable(name); }
            catch { return null; }
        }

        static float[] ParseShotTimes(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return new float[0];
            string[] parts = raw.Split(',');
            System.Collections.Generic.List<float> list = new System.Collections.Generic.List<float>();
            foreach (string part in parts)
            {
                float v;
                if (float.TryParse(part.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out v) && v >= 0f)
                    list.Add(v);
            }
            return list.ToArray();
        }

        void SaveSelfShot(float t, int index)
        {
            SaveSelfShotNamed("self-" + (index + 1).ToString("00") + "-" + ((int)(t * 1000)).ToString() + "ms");
        }

        void SaveSelfShotNamed(string name)
        {
            try
            {
                Directory.CreateDirectory(shotDir);
                string path = Path.Combine(shotDir, name + ".png");
                using (Bitmap bmp = new Bitmap(Math.Max(1, ClientSize.Width), Math.Max(1, ClientSize.Height)))
                {
                    DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                    bmp.Save(path, ImageFormat.Png);
                }
                Log("测试截图: " + path);
            }
            catch (Exception ex)
            {
                Log("测试截图失败: " + ex.Message);
            }
        }

        // ============================================================
        //  入口
        // ============================================================
        [STAThread]
        static void Main()
        {
            bool createdNew;
            instanceMutex = new Mutex(true, "Local\\AkiBurgerVoice.Launcher.SingleInstance", out createdNew);
            if (!createdNew)
            {
                try
                {
                    IntPtr existing = FindWindow(null, "AkiBurger Voice");
                    if (existing != IntPtr.Zero)
                    {
                        ShowWindow(existing, 9);
                        SetForegroundWindow(existing);
                    }
                }
                catch { }
                return;
            }

            try { SetProcessDPIAware(); }
            catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Launcher());
            GC.KeepAlive(instanceMutex);
            try { instanceMutex.ReleaseMutex(); }
            catch { }
        }
    }
}


