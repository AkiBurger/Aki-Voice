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
using System.Threading;
using System.Windows.Forms;

namespace AkiBurgerVoice
{
    // ============================================================
    //  AkiBurger Voice · 启动器（galgame 标题画面）
    //  设计：大标题 + 竖排菜单 + 角色大图 + 极简状态线
    //  素材：launcher/assets/bg-*.jpg（官方主视觉，纯 cover 裁切）
    //  功能：原启动流程全部保留（端口/路径/命令未改）
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
        const string UI_VERSION = "v0.3.0";

        // ===== 窗口布局（逻辑像素，DPI 整体缩放） =====
        const float W = 820f;
        const float H = 460f;
        const float WINDOW_RADIUS = 18f;
        const float TITLEBAR_H = 44f;
        const float FADE_SECONDS = 0.22f;
        const float CHAR_FADE_SECONDS = 0.16f;
        const float DRAWER_FADE_SECONDS = 0.16f;

        // ===== 颜色 token（MASTER-v3 §2） =====
        static readonly Color INK = Hex("#10224A");
        static readonly Color INK_MUTED = Hex("#4A5F8C");
        static readonly Color BLUE = Hex("#2F7CF6");
        static readonly Color BLUE_DEEP = Hex("#1D5FD0");
        static readonly Color BLUE_MID = Hex("#6C7BFF");
        static readonly Color PINK = Hex("#FF8FC7");
        static readonly Color PINK_DEEP = Hex("#E659A2");
        static readonly Color WHITE = Color.White;
        static readonly Color DANGER = Hex("#EF4444");
        static readonly Color MENU_SHADOW = Color.FromArgb(130, 12, 20, 48);

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

        // 背景/表情：0 idle, 1 thinking, 2 happy, 3 sad
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
        Font fontTitle, fontMenu, fontDrawerTitle, fontSans16, fontSans14, fontSans13;
        Font fontSans11, fontSans10, fontSans95;
        string fontNote = "";

        readonly Image[] bgImages = new Image[4];
        CharState curChar = CharState.Idle;
        CharState prevChar = CharState.Idle;
        float charFadeStart = -1f;

        System.Windows.Forms.Timer animTimer;
        readonly Stopwatch clock = new Stopwatch();
        bool introDone;
        bool working;
        string fatalTitle, fatalHuman;
        string stageNote = "正在检查运行环境…";
        float progress = 0f;
        string versionText = UI_VERSION;
        bool settingsOpen;
        bool aboutVisible;
        float drawerFadeStart = -1f;
        string transientNote;
        float transientAt = -100f;

        // 交互区域（逻辑坐标）
        RectangleF[] menuRects = new RectangleF[3];
        RectangleF itemDataRect, itemLogRect, itemAboutRect, backRect;
        RectangleF retryRect, viewLogRect, minRect;
        int hoverMenu = -1;
        int hoverItem = -1;
        int hoverFooter = -1;
        bool hoverMin;
        int pressed = 0;

        // QA 自截图 / 状态注入（仅环境变量启用；正常启动无影响）
        readonly string shotDir;
        readonly float[] shotTimes;
        int shotIndex;
        readonly bool qaMode;
        readonly string qaState;

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
            BackColor = Color.FromArgb(246, 250, 255);
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            DoubleBuffered = true;

            AutoScaleMode = AutoScaleMode.Dpi;
            physicalScale = PhysicalDpiScale(IntPtr.Zero);
            S = EffectiveScale(physicalScale);

            logPath = Path.Combine(PROJECT_ROOT, "logs", "launcher.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
            statePath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "AkiBurgerVoice", "window-state.txt");

            rows = new ServiceStatus[3];
            rows[0] = new ServiceStatus("01", "声音引擎");
            rows[1] = new ServiceStatus("02", "后端服务");
            rows[2] = new ServiceStatus("03", "声音模型");

            LoadDisplayFont();
            CreateFonts();

            AutoScaleDimensions = new SizeF(96f * physicalScale, 96f * physicalScale);
            winW = (int)Math.Round(W * S);
            winH = (int)Math.Round(H * S);
            MinimumSize = new Size((int)Math.Round(640f * S), (int)Math.Round(340f * S));
            ClientSize = new Size(winW, winH);
            ApplyRoundedRegion();

            RestoreWindowPosition();

            // 菜单 / 抽屉 / 底部文字按钮
            for (int i = 0; i < 3; i++)
                menuRects[i] = new RectangleF(48f, 180f + i * 48f, 260f, 42f);
            itemDataRect = new RectangleF(52f, 134f, 272f, 34f);
            itemLogRect = new RectangleF(52f, 178f, 272f, 34f);
            itemAboutRect = new RectangleF(52f, 222f, 272f, 34f);
            backRect = new RectangleF(52f, 334f, 272f, 34f);
            retryRect = new RectangleF(594f, 384f, 62f, 26f);
            viewLogRect = new RectangleF(664f, 384f, 100f, 26f);
            minRect = new RectangleF(W - 44f, 12f, 28f, 28f);

            animTimer = new System.Windows.Forms.Timer();
            animTimer.Interval = 16;
            animTimer.Tick += AnimTimer_Tick;

            shotDir = ReadEnv("ABV_LAUNCHER_SHOT_DIR");
            shotTimes = ParseShotTimes(ReadEnv("ABV_LAUNCHER_SHOT_TIMES"));
            qaState = ReadEnv("ABV_LAUNCHER_QA_STATE");
            qaMode = !string.IsNullOrEmpty(qaState);

            Log("启动器界面初始化（galgame 标题画面）" + (fontNote.Length > 0 ? " | " + fontNote : ""));
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
            if (qaMode) ApplyQaState(qaState);
            else StartWork();
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
                DisposeFont(fontTitle); DisposeFont(fontMenu); DisposeFont(fontDrawerTitle);
                DisposeFont(fontSans16); DisposeFont(fontSans14); DisposeFont(fontSans13);
                DisposeFont(fontSans11); DisposeFont(fontSans10); DisposeFont(fontSans95);
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
        //  DPI（PerMonitorV2）
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
            MinimumSize = new Size((int)Math.Round(640f * S), (int)Math.Round(340f * S));
            ClientSize = new Size(winW, winH);
            ApplyRoundedRegion();
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
        //  资源（字体 / 主视觉 / 版本）
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
            DisposeFont(fontTitle); DisposeFont(fontMenu); DisposeFont(fontDrawerTitle);
            DisposeFont(fontSans16); DisposeFont(fontSans14); DisposeFont(fontSans13);
            DisposeFont(fontSans11); DisposeFont(fontSans10); DisposeFont(fontSans95);

            FontStyle dispStyle = displayIsFallback ? FontStyle.Bold : FontStyle.Regular;
            fontTitle = new Font(displayFamily, 40f, dispStyle, GraphicsUnit.Pixel);
            fontMenu = new Font(displayFamily, 26f, dispStyle, GraphicsUnit.Pixel);
            fontDrawerTitle = new Font(displayFamily, 22f, dispStyle, GraphicsUnit.Pixel);

            string sansName = PickFamily("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI");
            fontSans16 = new Font(sansName, 16f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans14 = new Font(sansName, 14f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans13 = new Font(sansName, 13f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans11 = new Font(sansName, 11f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans10 = new Font(sansName, 10f, FontStyle.Regular, GraphicsUnit.Pixel);
            fontSans95 = new Font(sansName, 9.5f, FontStyle.Regular, GraphicsUnit.Pixel);
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
                                // 预缩放 + cover 裁切（不拉伸变形），任意窗口比例都保持人物比例
                                double sc = Math.Max((double)tw / src.Width, (double)th / src.Height);
                                int sw = Math.Min(src.Width, (int)Math.Round(tw / sc));
                                int sh = Math.Min(src.Height, (int)Math.Round(th / sc));
                                int sx = (src.Width - sw) / 2;
                                int sy = (src.Height - sh) / 2;
                                Bitmap scaled = new Bitmap(tw, th, PixelFormat.Format32bppPArgb);
                                using (Graphics sg = Graphics.FromImage(scaled))
                                {
                                    sg.InterpolationMode = InterpolationMode.HighQualityBicubic;
                                    sg.PixelOffsetMode = PixelOffsetMode.Default;
                                    sg.CompositingQuality = CompositingQuality.Default;
                                    sg.DrawImage(src, new Rectangle(0, 0, tw, th), sx, sy, sw, sh, GraphicsUnit.Pixel);
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
                Log("主视觉加载失败(" + resName + "): " + ex.Message);
            }
            Bitmap fallback = new Bitmap(Math.Max(1, winW), Math.Max(1, winH));
            using (Graphics g = Graphics.FromImage(fallback))
            using (LinearGradientBrush b = new LinearGradientBrush(new Rectangle(0, 0, fallback.Width, fallback.Height),
                Color.FromArgb(255, 226, 240), Color.FromArgb(220, 236, 255), 45f))
                g.FillRectangle(b, 0, 0, fallback.Width, fallback.Height);
            bgImages[idx] = fallback;
            return fallback;
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
                            if (inter.Width > 160 && inter.Height > 100) { x = sx; y = sy; break; }
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
        //  日志 / UI 线程 / 状态
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
                rows[index].State = state;
                if (detail != null) rows[index].Detail = detail;
                UpdateCharState();
                EnsureTimer();
                Invalidate();
            });
        }

        void SetStage(string note)
        {
            UI(delegate { if (note != null) stageNote = note; EnsureTimer(); Invalidate(); });
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
            float p = 3f;
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
            bool fade = !introDone
                || (charFadeStart >= 0f && t - charFadeStart < CHAR_FADE_SECONDS + 0.04f)
                || (drawerFadeStart >= 0f && t - drawerFadeStart < DRAWER_FADE_SECONDS + 0.04f);
            bool progressMoving = progress < TargetProgress() - 0.5f;
            bool pendingShots = shotDir != null && shotIndex < shotTimes.Length;
            int interval = 16;
            if (fade) interval = 16;
            else if (progressMoving) interval = 120;
            else if (pendingShots) interval = 100;
            else
            {
                if (animTimer.Enabled) animTimer.Stop();
                return;
            }
            if (animTimer.Interval != interval) animTimer.Interval = interval;
            if (!animTimer.Enabled) animTimer.Start();
        }

        void AnimTimer_Tick(object sender, EventArgs e)
        {
            float t = (float)clock.Elapsed.TotalSeconds;
            if (!introDone && t >= FADE_SECONDS) introDone = true;
            if (charFadeStart >= 0f && t - charFadeStart > CHAR_FADE_SECONDS + 0.1f) charFadeStart = -1f;
            if (drawerFadeStart >= 0f && t - drawerFadeStart > DRAWER_FADE_SECONDS + 0.1f) drawerFadeStart = -1f;

            float target = TargetProgress();
            bool progressChanged = false;
            if (progress < target)
            {
                progress = Math.Min(target, progress + Math.Max(0.8f, (target - progress) * 0.18f));
                progressChanged = true;
            }
            else if (progress > target + 0.5f)
            {
                progress = target;
                progressChanged = true;
            }

            bool fullRedraw = !introDone || charFadeStart >= 0f || drawerFadeStart >= 0f;
            // 检查中进度线变化：只重绘底部；其它过渡：全窗重绘
            if (fullRedraw) Invalidate();
            else if (progressChanged) InvalidateRectLogical(40f, 380f, 620f, 70f);
            else Invalidate();

            if (shotDir != null && shotIndex < shotTimes.Length && t >= shotTimes[shotIndex])
            {
                SaveSelfShot(t, shotIndex);
                shotIndex++;
            }
            EnsureTimer();
        }

        void InvalidateRectLogical(float x, float y, float w, float h)
        {
            Invalidate(new Rectangle(
                (int)Math.Floor(x * S) - 2,
                (int)Math.Floor(y * S) - 2,
                (int)Math.Ceiling(w * S) + 4,
                (int)Math.Ceiling(h * S) + 4));
        }

        // ============================================================
        //  QA 状态注入（仅 ABV_LAUNCHER_QA_STATE 存在时；正常启动走真实流程）
        // ============================================================
        void ApplyQaState(string state)
        {
            settingsOpen = false;
            aboutVisible = false;
            fatalTitle = null;
            working = false;
            for (int i = 0; i < rows.Length; i++)
            {
                rows[i].State = StepState.Idle;
                rows[i].Detail = "等待检查";
            }
            string s = (state ?? "").Trim().ToLowerInvariant();
            if (s == "checking")
            {
                rows[0].State = StepState.Checking;
                rows[0].Detail = "正在启动…";
                rows[2].State = StepState.Idle;
                stageNote = "正在启动声音引擎…";
                progress = 14f;
            }
            else if (s == "failure")
            {
                rows[0].State = StepState.Failed;
                rows[0].Detail = "启动超时";
                fatalTitle = "声音引擎启动超时";
                fatalHuman = "声音引擎没有按时就绪，请重试或查看日志。";
                stageNote = fatalHuman;
                progress = 12f;
            }
            else
            {
                rows[0].State = StepState.Ready; rows[0].Detail = "127.0.0.1:9880";
                rows[1].State = StepState.Ready; rows[1].Detail = "127.0.0.1:8017";
                rows[2].State = StepState.Ready; rows[2].Detail = "setsuna_light_e2_s362.pth + setsuna_light-e8.ckpt";
                stageNote = "准备就绪";
                progress = 100f;
                if (s == "settings")
                {
                    settingsOpen = true;
                    aboutVisible = true;
                    drawerFadeStart = -1f;
                }
            }
            UpdateCharState();
            if (charFadeStart >= 0f) charFadeStart = (float)clock.Elapsed.TotalSeconds - CHAR_FADE_SECONDS;
            EnsureTimer();
            Invalidate();
            Log("QA 状态: " + s);
        }

        // ============================================================
        //  启动流程（逻辑与旧版一致，仅状态文案适配新 UI）
        // ============================================================
        void StartWork()
        {
            if (working) return;
            working = true;
            UI(delegate
            {
                fatalTitle = null;
                fatalHuman = null;
                settingsOpen = false;
                aboutVisible = false;
                for (int i = 0; i < rows.Length; i++)
                {
                    rows[i].State = StepState.Idle;
                    rows[i].Detail = "等待检查";
                }
                stageNote = "正在检查运行环境…";
                progress = 3f;
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
                SetStage("正在检查运行环境…");

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
                    SetStage("正在等待声音引擎就绪…");
                }
                else
                {
                    SetStage("正在启动声音引擎… 首次加载需要 1~3 分钟");
                    SetRow(0, StepState.Checking, "正在启动声音引擎…");
                    StartHidden(sovitsRoot, sovitsPy, "api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml", "engine.log");
                }

                if (!WaitHttp(ENGINE_URL + "/docs", 240))
                {
                    SetRow(0, StepState.Failed, "启动超时");
                    Fail("声音引擎启动超时", "详见 logs\\engine.log（可能是显存不足或依赖缺失）");
                    return;
                }
                Log("引擎就绪");
                SetRow(0, StepState.Ready, "127.0.0.1:9880");
                SetStage("正在加载声音模型…");

                // ---------- 2. 挂载训练好的声音模型 ----------
                SetRow(2, StepState.Checking, "扫描训练权重…");
                TryAttachWeights();

                // ---------- 2.5 翻译服务（可选） ----------
                if (!PortListening(11434))
                {
                    SetStage("正在检查翻译服务…");
                    StartOllama();
                }
                else
                {
                    Log("翻译服务已在运行（会优先用 Qwen 翻译）");
                }

                // ---------- 3. 后端 ----------
                SetStage("正在启动后端服务…");
                if (PortListening(8017))
                {
                    Log("后端已在运行");
                    SetRow(1, StepState.Checking, "已检测到后端 · 等待响应…");
                }
                else
                {
                    SetRow(1, StepState.Checking, "正在启动后端服务…");
                    StartHidden(PROJECT_ROOT, sovitsPy, @"src\backend\app.py", "backend.log");
                }

                if (!WaitHttp(BACKEND_URL + "/api/health", 60))
                {
                    SetRow(1, StepState.Failed, "健康检查超时");
                    Fail("后端服务启动超时", "详见 logs\\backend.log");
                    return;
                }
                Log("后端就绪");
                SetRow(1, StepState.Ready, "127.0.0.1:8017");

                // ---------- 4. 就绪 ----------
                SetStage("准备就绪");
                Log("启动流程完成，等待开始创作");
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
                fatalHuman = Humanize(title, detail);
                stageNote = fatalHuman;
                UpdateCharState();
                EnsureTimer();
                Invalidate();
            });
        }

        static string Humanize(string title, string detail)
        {
            if (title == "找不到 GPT-SoVITS 目录")
                return "没找到声音引擎目录，请确认 D:\\Dev\\ai 下的 02_GPT-SoVITS_* 文件夹。";
            if (title == "找不到 Python 运行环境")
                return "声音引擎的 Python 环境不完整，请检查 .venv。";
            if (title == "声音引擎启动超时")
                return "声音引擎没有按时就绪，请重试或查看日志。";
            if (title == "后端服务启动超时")
                return "后端服务没有按时就绪，请重试或查看日志。";
            if (title == "启动失败")
                return "启动过程中出现异常，请查看日志。";
            return title;
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
                string root = FindSovitsRoot();
                string sovitsDir = Path.Combine(root, "SoVITS_weights_v2Pro");
                string gptDir = Path.Combine(root, "GPT_weights_v2Pro");
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
        //  动作
        // ============================================================
        void OpenPage()
        {
            try
            {
                Process.Start(new ProcessStartInfo(PAGE_URL) { UseShellExecute = true });
                Log("已打开浏览器");
                ShowTransient("界面已打开");
            }
            catch (Exception ex)
            {
                Log("打开浏览器失败: " + ex.Message);
                ShowTransient("打开浏览器失败，请手动访问 127.0.0.1:8017");
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
                ShowTransient("已打开数据目录");
            }
            catch (Exception ex)
            {
                Log("打开数据目录失败: " + ex.Message);
                ShowTransient("打开数据目录失败");
            }
        }

        void OpenLog()
        {
            try
            {
                if (!File.Exists(logPath)) File.WriteAllText(logPath, "", Encoding.UTF8);
                Process.Start("notepad.exe", "\"" + logPath + "\"");
                Log("打开日志: " + logPath);
                ShowTransient("正在打开日志");
            }
            catch (Exception ex)
            {
                Log("打开日志失败: " + ex.Message);
                ShowTransient("打开日志失败");
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

        void ShowTransient(string note)
        {
            UI(delegate
            {
                transientNote = note;
                transientAt = (float)clock.Elapsed.TotalSeconds;
                Invalidate();
                EnsureTimer();
            });
        }

        void OpenSettings()
        {
            settingsOpen = true;
            aboutVisible = false;
            drawerFadeStart = (float)clock.Elapsed.TotalSeconds;
            Log("打开设置");
            EnsureTimer();
            Invalidate();
        }

        void CloseSettings()
        {
            settingsOpen = false;
            aboutVisible = false;
            Log("关闭设置");
            Invalidate();
        }

        void StartGame()
        {
            if (LaunchEnabled)
            {
                OpenPage();
                return;
            }
            if (fatalTitle != null) { ShowTransient("启动失败，请先重试"); return; }
            ShowTransient("服务还没就绪，请稍候…");
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
            if (minRect.Contains(p)) return 30;
            if (settingsOpen)
            {
                if (itemDataRect.Contains(p)) return 21;
                if (itemLogRect.Contains(p)) return 22;
                if (itemAboutRect.Contains(p)) return 23;
                if (backRect.Contains(p)) return 24;
                return 0;
            }
            if (fatalTitle != null)
            {
                if (retryRect.Contains(p)) return 11;
                if (viewLogRect.Contains(p)) return 12;
            }
            for (int i = 0; i < 3; i++)
                if (menuRects[i].Contains(p)) return 1 + i;
            return 0;
        }

        void Activate(int id)
        {
            switch (id)
            {
                case 1: StartGame(); break;
                case 2: OpenSettings(); break;
                case 3: CloseLauncher(); break;
                case 11: Retry(); break;
                case 12: OpenLog(); break;
                case 21: OpenDataDir(); break;
                case 22: OpenLog(); break;
                case 23: aboutVisible = true; Log("查看关于"); Invalidate(); break;
                case 24: CloseSettings(); break;
                case 30: MinimizeWindow(); break;
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            PointF p = ToLogical(e.Location);
            int hit = HitTest(p);
            int hm = -1, hi = -1, hf = -1;
            bool hmin = false;
            if (hit == 30) hmin = true;
            else if (hit >= 1 && hit <= 3) hm = hit - 1;
            else if (hit >= 21 && hit <= 24) hi = hit - 21;
            else if (hit == 11 || hit == 12) hf = hit;
            bool changed = hm != hoverMenu || hi != hoverItem || hf != hoverFooter || hmin != hoverMin;
            if (changed)
            {
                hoverMenu = hm;
                hoverItem = hi;
                hoverFooter = hf;
                hoverMin = hmin;
                Cursor = hit != 0 ? Cursors.Hand : Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            hoverMenu = -1;
            hoverItem = -1;
            hoverFooter = -1;
            hoverMin = false;
            pressed = 0;
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
            pressed = HitTest(p);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            PointF p = ToLogical(e.Location);
            int hit = HitTest(p);
            int down = pressed;
            pressed = 0;
            if (down != 0 && down == hit) Activate(down);
            Invalidate();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Escape)
            {
                if (settingsOpen) CloseSettings();
                else CloseLauncher();
                e.Handled = true;
            }
            else if (e.KeyCode == Keys.Enter)
            {
                if (settingsOpen) CloseSettings();
                else StartGame();
                e.Handled = true;
            }
        }

        // ============================================================
        //  绘制
        // ============================================================
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.Default;
            g.CompositingQuality = CompositingQuality.Default;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;

            float t = (float)clock.Elapsed.TotalSeconds;
            float intro = introDone ? 1f : Clamp01(t / FADE_SECONDS);

            using (SolidBrush bg = new SolidBrush(BackColor)) g.FillRectangle(bg, 0, 0, winW, winH);
            DrawBackgroundPhysical(g, t, intro);

            GraphicsState st = g.Save();
            g.ScaleTransform(S, S);
            using (GraphicsPath round = RoundRectPath(new RectangleF(0f, 0f, W, H), WINDOW_RADIUS))
            {
                g.SetClip(round);
                DrawUI(g, t, intro);
            }
            g.Restore(st);
        }

        void DrawBackgroundPhysical(Graphics g, float t, float intro)
        {
            Image cur = EnsureBg(curChar);
            bool fading = prevChar != curChar && charFadeStart >= 0f;
            if (fading)
            {
                float p = Clamp01((t - charFadeStart) / CHAR_FADE_SECONDS);
                Image prev = EnsureBg(prevChar);
                DrawImageAlphaPhysical(g, prev, (1f - p) * intro);
                DrawImageAlphaPhysical(g, cur, p * intro);
            }
            else
            {
                DrawImageAlphaPhysical(g, cur, intro);
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
                g.DrawImage(img, new Rectangle(0, 0, winW, winH), 0f, 0f, img.Width, img.Height, GraphicsUnit.Pixel, ia);
            }
        }

        void DrawUI(Graphics g, float t, float intro)
        {
            float a = intro;
            DrawLeftVeil(g, a);
            if (!settingsOpen)
            {
                DrawTitleBlock(g, a);
                DrawMenu(g, a);
            }
            DrawFooter(g, t, a);
            if (settingsOpen) DrawSettingsDrawer(g, t, a);
            DrawMinimize(g, a);
        }

        // 左侧很淡的暗色渐层（代码绘制，不改背景图），保证白字可读
        void DrawLeftVeil(Graphics g, float a)
        {
            using (LinearGradientBrush b = MakeGradient(new RectangleF(0f, 0f, 560f, H), 0f,
                new Color[] { Color.FromArgb((int)(150 * a), 12, 20, 48), Color.FromArgb((int)(64 * a), 12, 20, 48), Color.FromArgb(0, 12, 20, 48) },
                new float[] { 0f, 0.55f, 1f }))
                g.FillRectangle(b, 0f, 0f, 560f, H);
            using (LinearGradientBrush b = MakeGradient(new RectangleF(0f, 300f, W, 160f), 90f,
                new Color[] { Color.FromArgb(0, 12, 20, 48), Color.FromArgb((int)(120 * a), 12, 20, 48) },
                new float[] { 0f, 1f }))
                g.FillRectangle(b, 0f, 300f, W, 160f);
        }

        void DrawTitleBlock(Graphics g, float a)
        {
            DrawShadowedText(g, "AkiBurger Voice", fontTitle, 56f, 40f, A(WHITE, a), a);
            DrawText(g, "こえを、つくる。", fontSans13, A(WHITE, 0.92f * a), 58f, 104f);
            DrawText(g, versionText, fontSans95, A(WHITE, 0.72f * a), 58f, 126f);
        }

        void DrawMenu(Graphics g, float a)
        {
            for (int i = 0; i < 3; i++)
            {
                string label = i == 0 ? "开始创作" : (i == 1 ? "设置" : "退出");
                bool enabled = i != 0 || LaunchEnabled;
                bool hover = hoverMenu == i;
                float x = 56f + (hover ? 4f : 0f);
                float y = 188f + i * 48f;
                if (hover && enabled)
                {
                    using (LinearGradientBrush b = MakeGradient(new RectangleF(48f, y + 4f, 3f, 28f), 90f,
                        new Color[] { A(PINK, a), A(BLUE, a) }, new float[] { 0f, 1f }))
                        g.FillRectangle(b, 48f, y + 4f, 3f, 28f);
                }
                Color c = !enabled
                    ? Color.FromArgb((int)(110 * a), 255, 255, 255)
                    : (hover ? A(WHITE, a) : A(WHITE, 0.92f * a));
                DrawShadowedText(g, label, fontMenu, x, y, c, a);
            }
        }

        void DrawFooter(Graphics g, float t, float a)
        {
            float lineY = 424f;
            using (Pen basePen = new Pen(Color.FromArgb((int)(60 * a), 255, 255, 255), 2f))
                g.DrawLine(basePen, 56f, lineY, 640f, lineY);

            float pct = Clamp01(progress / 100f);
            float fillW = 584f * pct;
            if (fillW > 2f)
            {
                using (LinearGradientBrush b = MakeGradient(new RectangleF(56f, lineY - 1f, Math.Max(4f, fillW), 2f), 0f,
                    new Color[] { A(BLUE, a), A(BLUE_MID, a), A(PINK, a) },
                    new float[] { 0f, 0.55f, 1f }))
                    g.FillRectangle(b, 56f, lineY - 1f, fillW, 2f);
            }

            string note = stageNote;
            Color noteColor = A(WHITE, 0.86f * a);
            if (transientNote != null && t - transientAt < 2.4f)
            {
                note = transientNote;
                noteColor = A(Color.FromArgb(255, 236, 246), 0.95f * a);
            }
            if (fatalTitle != null)
            {
                note = fatalHuman;
                noteColor = A(Color.FromArgb(255, 255, 186, 190), 0.98f * a);
            }

            DrawText(g, note, fontSans11, noteColor, new RectangleF(56f, 394f, 520f, 20f), SfNearEllipsis);

            if (fatalTitle != null)
            {
                DrawFooterButton(g, "重试", retryRect, hoverFooter == 11, a);
                DrawFooterButton(g, "查看日志", viewLogRect, hoverFooter == 12, a);
            }
        }

        void DrawFooterButton(Graphics g, string text, RectangleF r, bool hover, float a)
        {
            Color c = hover ? A(PINK, a) : A(WHITE, 0.92f * a);
            DrawText(g, text, fontSans11, c, new RectangleF(r.X, r.Y + 4f, r.Width, 20f), SfNear);
            float w = g.MeasureString(text, fontSans11).Width;
            using (Pen p = new Pen(Color.FromArgb((int)((hover ? 200 : 110) * a), c), 1f))
                g.DrawLine(p, r.X, r.Y + 22f, r.X + w, r.Y + 22f);
        }

        void DrawSettingsDrawer(Graphics g, float t, float a)
        {
            float da = 1f;
            if (drawerFadeStart >= 0f) da = Clamp01((t - drawerFadeStart) / DRAWER_FADE_SECONDS);
            float aa = a * da;
            RectangleF panel = new RectangleF(40f, 70f, 300f, 316f);

            for (int i = 3; i >= 1; i--)
            {
                using (GraphicsPath sp = RoundRectPath(new RectangleF(panel.X + i, panel.Y + 4f + i, panel.Width, panel.Height), 16f))
                using (SolidBrush sb = new SolidBrush(Color.FromArgb((int)((8 + i * 4) * aa), 20, 30, 60)))
                    g.FillPath(sb, sp);
            }
            using (GraphicsPath p = RoundRectPath(panel, 16f))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb((int)(244 * aa), 252, 253, 255))) g.FillPath(b, p);
                using (Pen pen = new Pen(Color.FromArgb((int)(235 * aa), 255, 255, 255), 1f)) g.DrawPath(pen, p);
            }
            DrawText(g, "设置", fontDrawerTitle, A(INK, aa), 60f, 84f);
            using (Pen pen = new Pen(Color.FromArgb((int)(45 * aa), INK), 1f))
                g.DrawLine(pen, 60f, 124f, 320f, 124f);

            DrawDrawerItem(g, "打开数据目录", 146f, hoverItem == 0, aa);
            DrawDrawerItem(g, "查看日志", 190f, hoverItem == 1, aa);
            DrawDrawerItem(g, "关于", 234f, hoverItem == 2, aa);

            if (aboutVisible)
            {
                DrawText(g, "AkiBurger Voice " + versionText, fontSans95, A(INK_MUTED, 0.95f * aa), 62f, 276f);
                DrawText(g, "声音引擎端口 9880 · 后端端口 8017", fontSans95, A(INK_MUTED, 0.95f * aa), 62f, 292f);
                DrawText(g, "本地声音克隆与配音工作台", fontSans95, A(INK_MUTED, 0.95f * aa), 62f, 308f);
            }

            bool backHover = hoverItem == 3;
            DrawText(g, "← 返回", fontSans14, A(backHover ? BLUE_DEEP : BLUE, aa), 62f, 342f);
            if (backHover)
            {
                using (Pen pen = new Pen(A(BLUE, aa), 1f)) g.DrawLine(pen, 62f, 362f, 112f, 362f);
            }
        }

        void DrawDrawerItem(Graphics g, string text, float y, bool hover, float a)
        {
            Color c = hover ? A(BLUE_DEEP, a) : A(INK, a);
            float x = 62f + (hover ? 4f : 0f);
            DrawText(g, text, fontSans16, c, x, y);
        }

        void DrawMinimize(Graphics g, float a)
        {
            using (GraphicsPath p = RoundRectPath(minRect, 9f))
            {
                using (SolidBrush b = new SolidBrush(Color.FromArgb((int)((hoverMin ? 190 : 120) * a), 255, 255, 255))) g.FillPath(b, p);
                using (Pen pen = new Pen(A(WHITE, (hoverMin ? 0.9f : 0.55f) * a), 1f)) g.DrawPath(pen, p);
            }
            using (Pen pen = new Pen(A(INK, (hoverMin ? 0.9f : 0.65f) * a), 1.6f))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                g.DrawLine(pen, minRect.X + 9f, minRect.Y + 14f, minRect.X + 19f, minRect.Y + 14f);
            }
        }

        // ============================================================
        //  绘制小工具
        // ============================================================
        void DrawShadowedText(Graphics g, string text, Font font, float x, float y, Color fill, float a)
        {
            using (SolidBrush sh = new SolidBrush(Color.FromArgb((int)(MENU_SHADOW.A * a), MENU_SHADOW)))
            {
                g.DrawString(text, font, sh, x + 2f, y + 3f);
                g.DrawString(text, font, sh, x + 1f, y + 3f);
            }
            using (SolidBrush b = new SolidBrush(fill)) g.DrawString(text, font, b, x, y);
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

        static readonly StringFormat SfNear = MakeSf(StringAlignment.Near, StringAlignment.Near, false);
        static readonly StringFormat SfNearEllipsis = MakeSf(StringAlignment.Near, StringAlignment.Near, true);

        static StringFormat MakeSf(StringAlignment h, StringAlignment v, bool ellipsis)
        {
            StringFormat f = new StringFormat(StringFormatFlags.NoWrap);
            f.Alignment = h;
            f.LineAlignment = v;
            if (ellipsis) f.Trimming = StringTrimming.EllipsisCharacter;
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
            try
            {
                Directory.CreateDirectory(shotDir);
                string path = Path.Combine(shotDir, "self-" + (index + 1).ToString("00") + "-" + ((int)(t * 1000)).ToString() + "ms.png");
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
