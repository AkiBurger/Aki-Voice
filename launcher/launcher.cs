using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace AkiBurgerVoice
{
    public class Launcher : Form
    {
        // ===== 配置 =====
        const string PROJECT_ROOT = @"D:\Dev\projects\voice-studio";
        const string AI_ROOT = @"D:\Dev\ai";
        const string FFMPEG_BIN = @"D:\Dev\tools\ffmpeg\bin";
        const string ENGINE_URL = "http://127.0.0.1:9880";
        const string BACKEND_URL = "http://127.0.0.1:8017";
        const string PAGE_URL = "http://127.0.0.1:8017/static/index.html";
        const string GPT_WEIGHTS = "GPT_weights_v2Pro/setsuna_light-e8.ckpt";
        const string SOVITS_WEIGHTS = "SoVITS_weights_v2Pro/setsuna_light_e6_s1086.pth";

        string logPath;
        Label lblStatus;
        Label lblDetail;
        ProgressBar bar;
        bool okDone = false;
        string fatalError = null;

        public Launcher()
        {
            Text = "AkiBurger Voice";
            ClientSize = new Size(440, 170);
            StartPosition = FormStartPosition.CenterScreen;
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            BackColor = Color.FromArgb(20, 22, 26);
            ForeColor = Color.FromArgb(232, 234, 237);
            Font = new Font("Microsoft YaHei UI", 10f);

            var title = new Label();
            title.Text = "AkiBurger Voice";
            title.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
            title.ForeColor = Color.FromArgb(74, 158, 255);
            title.AutoSize = false;
            title.TextAlign = ContentAlignment.MiddleCenter;
            title.SetBounds(0, 16, ClientSize.Width, 30);
            Controls.Add(title);

            lblStatus = new Label();
            lblStatus.Text = "正在启动...";
            lblStatus.AutoSize = false;
            lblStatus.TextAlign = ContentAlignment.MiddleCenter;
            lblStatus.SetBounds(0, 56, ClientSize.Width, 26);
            Controls.Add(lblStatus);

            lblDetail = new Label();
            lblDetail.Text = "";
            lblDetail.AutoSize = false;
            lblDetail.TextAlign = ContentAlignment.MiddleCenter;
            lblDetail.ForeColor = Color.FromArgb(154, 160, 170);
            lblDetail.Font = new Font("Microsoft YaHei UI", 8.5f);
            lblDetail.SetBounds(10, 86, ClientSize.Width - 20, 40);
            Controls.Add(lblDetail);

            bar = new ProgressBar();
            bar.Style = ProgressBarStyle.Marquee;
            bar.MarqueeAnimationSpeed = 30;
            bar.SetBounds(30, 132, ClientSize.Width - 60, 8);
            Controls.Add(bar);

            logPath = Path.Combine(PROJECT_ROOT, "logs", "launcher.log");
            Directory.CreateDirectory(Path.GetDirectoryName(logPath));
        }

        void Log(string msg)
        {
            try { File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + msg + Environment.NewLine, Encoding.UTF8); }
            catch { }
        }

        void SetStatus(string status, string detail)
        {
            try
            {
                Invoke(new Action(() =>
                {
                    lblStatus.Text = status;
                    lblDetail.Text = detail ?? "";
                }));
            }
            catch { }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            var t = new Thread(Work);
            t.IsBackground = true;
            t.Start();
        }

        void Work()
        {
            try
            {
                Log("=== 启动器开始 ===");
                SetStatus("检查运行环境...", "");

                string sovitsRoot = FindSovitsRoot();
                if (sovitsRoot == null)
                {
                    Fail("找不到 GPT-SoVITS 目录", @"期望在 " + AI_ROOT + @" 下找到 02_GPT-SoVITS_* 文件夹");
                    return;
                }
                string sovitsPy = Path.GetFullPath(Path.Combine(sovitsRoot, @"..\.venv\Scripts\python.exe"));
                Log("GPT-SoVITS: " + sovitsRoot);
                Log("python: " + sovitsPy);

                if (!File.Exists(sovitsPy))
                {
                    Fail("找不到 Python 运行环境", sovitsPy);
                    return;
                }

                // ---------- 1. 引擎 ----------
                if (PortListening(9880))
                {
                    Log("引擎已在运行");
                }
                else
                {
                    SetStatus("正在启动声音引擎...", "首次加载模型需要 1~3 分钟，请耐心等待");
                    StartHidden(sovitsRoot, sovitsPy, "api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml", "engine.log");
                }

                SetStatus("等待声音引擎就绪...", "首次加载模型需要 1~3 分钟");
                if (!WaitHttp(ENGINE_URL + "/docs", 240))
                {
                    Fail("声音引擎启动超时", "详见 logs\\engine.log（可能是显存不足或依赖缺失）");
                    return;
                }
                Log("引擎就绪");

                // ---------- 2. 挂载训练好的声音 ----------
                SetStatus("加载训练好的雪菜声音...", "");
                TryAttachWeights();

                // ---------- 3. 后端 ----------
                if (PortListening(8017))
                {
                    Log("后端已在运行");
                }
                else
                {
                    SetStatus("正在启动后端服务...", "");
                    StartHidden(PROJECT_ROOT, sovitsPy, @"src\backend\app.py", "backend.log");
                }

                SetStatus("等待后端服务就绪...", "");
                if (!WaitHttp(BACKEND_URL + "/api/health", 60))
                {
                    Fail("后端服务启动超时", "详见 logs\\backend.log");
                    return;
                }
                Log("后端就绪");

                // ---------- 4. 打开界面 ----------
                SetStatus("启动完成，正在打开界面...", "");
                Thread.Sleep(300);
                Process.Start(new ProcessStartInfo(PAGE_URL) { UseShellExecute = true });
                Log("已打开浏览器");
                okDone = true;

                Invoke(new Action(() =>
                {
                    bar.Style = ProgressBarStyle.Continuous;
                    bar.Value = 100;
                    lblStatus.Text = "启动完成";
                    lblDetail.Text = "浏览器已打开。关闭本窗口不会停止服务。";
                    var timer = new System.Windows.Forms.Timer();
                    timer.Interval = 1500;
                    timer.Tick += (s, ev) => { timer.Stop(); Close(); };
                    timer.Start();
                }));
            }
            catch (Exception ex)
            {
                Log("异常: " + ex);
                Fail("启动失败", ex.Message);
            }
        }

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
            // cmd 负责重定向输出；CreateNoWindow 保证不弹黑窗口
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

        void TryAttachWeights()
        {
            try
            {
                HttpGet(ENGINE_URL + "/set_gpt_weights?weights_path=" + GPT_WEIGHTS, 120);
                HttpGet(ENGINE_URL + "/set_sovits_weights?weights_path=" + SOVITS_WEIGHTS, 120);
                Log("训练权重已挂载");
            }
            catch (Exception ex)
            {
                Log("挂载权重失败（将使用默认音色）: " + ex.Message);
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

        void Fail(string title, string detail)
        {
            Log("失败: " + title + " | " + detail);
            try
            {
                Invoke(new Action(() =>
                {
                    bar.Style = ProgressBarStyle.Continuous;
                    lblStatus.Text = title;
                    lblDetail.Text = detail;
                    MessageBox.Show(this,
                        title + Environment.NewLine + Environment.NewLine + detail +
                        Environment.NewLine + Environment.NewLine + "详细日志：" + logPath,
                        "AkiBurger Voice", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    Close();
                }));
            }
            catch { }
        }

        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new Launcher());
        }
    }
}
