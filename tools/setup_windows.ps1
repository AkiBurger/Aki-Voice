#requires -Version 5.1
<#
AkiBurger Voice - one-step setup helper (Windows).

What it does:
  - checks git / python / nvidia-smi
  - clones GPT-SoVITS if it is missing
  - downloads GPT-SoVITS pretrained models (optional)
  - downloads a static ffmpeg build
  - downloads Fun-ASR-Nano and the zh->ja translation model (optional)
  - saves discovered paths as user environment variables
  - runs tools/check_env.py

It does NOT install GPT-SoVITS Python dependencies or CUDA drivers.
Use -DryRun to print actions without changing anything.
#>
[CmdletBinding()]
param(
    [string]$AiRoot = "",
    [string]$HfMirror = "https://hf-mirror.com",
    [switch]$SkipModels,
    [switch]$SkipFunASR,
    [switch]$SkipTranslateModel,
    [switch]$SkipFFmpeg,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $AiRoot) {
    if ($env:ABV_AI_ROOT) { $AiRoot = $env:ABV_AI_ROOT }
    else { $AiRoot = Join-Path (Split-Path -Parent (Split-Path -Parent $ProjectRoot)) "ai" }
}
$ToolsRoot = Join-Path (Split-Path -Parent $AiRoot) "tools"
$FfmpegBin = Join-Path $ToolsRoot "ffmpeg\bin"
$HfCacheDefault = Join-Path (Split-Path -Parent $AiRoot) "cache\huggingface\hub"

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Info($text) { Write-Host "    $text" }
function Warn($text) { Write-Host "[warn] $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "[fail] $text" -ForegroundColor Red }

function Find-Sovits {
    if (-not (Test-Path $AiRoot)) { return $null }
    foreach ($dir in Get-ChildItem $AiRoot -Directory -ErrorAction SilentlyContinue) {
        if ($dir.Name -notmatch "GPT-SoVITS") { continue }
        $candidate = Join-Path $dir.FullName "GPT-SoVITS"
        if (Test-Path (Join-Path $candidate "api_v2.py")) { return $candidate }
        if (Test-Path (Join-Path $dir.FullName "api_v2.py")) { return $dir.FullName }
    }
    return $null
}

function Find-Python($sovits) {
    if ($sovits) {
        $venv = Join-Path $sovits ".venv\Scripts\python.exe"
        if (Test-Path $venv) { return $venv }
    }
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

function Ensure-HfHub($python) {
    & $python -c "import huggingface_hub" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn "huggingface_hub is missing, installing it into the selected Python environment"
        if (-not $DryRun) {
            & $python -m pip install --disable-pip-version-check -q -U huggingface_hub
            if ($LASTEXITCODE -ne 0) { throw "pip install huggingface_hub failed" }
        }
    }
}

function Download-Snapshot($python, $repo, $cacheDir) {
    $code = "from huggingface_hub import snapshot_download; print(snapshot_download('$repo', cache_dir=r'$cacheDir'))"
    $out = & $python -c $code
    if ($LASTEXITCODE -ne 0) { throw "snapshot download failed: $repo" }
    return ($out | Select-Object -Last 1)
}

function Save-UserEnv($name, $value) {
    if ($DryRun) { Info "would set $name=$value"; return }
    [Environment]::SetEnvironmentVariable($name, $value, "User")
    Set-Item -Path "Env:$name" -Value $value
    Info "saved $name=$value"
}

Step "project: $ProjectRoot"
Step "ai root: $AiRoot"
if ($DryRun) { Warn "dry run: no download or environment change" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git not found. Install Git for Windows first: https://git-scm.com/download/win"
    exit 1
}

$gpu = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($gpu) { Info "nvidia-smi found" } else { Warn "nvidia-smi not found; training and synthesis need an NVIDIA GPU" }

# ---------- GPT-SoVITS ----------
Step "GPT-SoVITS"
$sovits = Find-Sovits
if (-not $sovits) {
    $target = Join-Path (Join-Path $AiRoot "02_GPT-SoVITS") "GPT-SoVITS"
    Info "clone into: $target"
    if (-not $DryRun) {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS $target
        if ($LASTEXITCODE -ne 0) { throw "git clone GPT-SoVITS failed" }
        $sovits = $target
    }
} else {
    Info "found: $sovits"
}
Save-UserEnv "ABV_AI_ROOT" $AiRoot
if ($sovits) { Save-UserEnv "ABV_SOVITS_ROOT" $sovits }

$python = Find-Python $sovits
if (-not $python) { Fail "python not found. Install Python 3.10+ or prepare the GPT-SoVITS venv first."; exit 1 }
Info "python: $python"

# ---------- pretrained models ----------
if (-not $SkipModels) {
    Step "GPT-SoVITS pretrained models"
    if (-not $sovits) {
        Warn "skipped: GPT-SoVITS is not available"
    } else {
        $pre = Join-Path $sovits "GPT_SoVITS\pretrained_models"
        if (Test-Path (Join-Path $pre "v2Pro")) {
            Info "already present: $pre"
        } elseif ($DryRun) {
            Info "would download lj1995/GPT-SoVITS into $pre"
        } else {
            Ensure-HfHub $python
            New-Item -ItemType Directory -Force -Path $pre | Out-Null
            Info "downloading pretrained models (several GB, may take a while)"
            & $python -m huggingface_hub.commands.huggingface_cli download lj1995/GPT-SoVITS --local-dir $pre
            if ($LASTEXITCODE -ne 0) {
                Warn "download failed. Try manually:"
                Warn "  huggingface-cli download lj1995/GPT-SoVITS --local-dir `"$pre`""
            }
        }
    }
}

# ---------- ffmpeg ----------
if (-not $SkipFFmpeg) {
    Step "ffmpeg"
    $ffmpegExe = Join-Path $FfmpegBin "ffmpeg.exe"
    if (Test-Path $ffmpegExe) {
        Info "already present: $ffmpegExe"
    } elseif ($DryRun) {
        Info "would download ffmpeg-release-essentials.zip into $FfmpegBin"
    } else {
        $zip = Join-Path $env:TEMP "abv-ffmpeg.zip"
        $url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
        Info "downloading $url"
        try {
            Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
            $tmp = Join-Path $env:TEMP ("abv-ffmpeg-" + [guid]::NewGuid().ToString("N"))
            Expand-Archive -Path $zip -DestinationPath $tmp -Force
            $found = Get-ChildItem $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if (-not $found) { throw "ffmpeg.exe not found in archive" }
            New-Item -ItemType Directory -Force -Path $FfmpegBin | Out-Null
            Copy-Item (Join-Path $found.DirectoryName "*") $FfmpegBin -Force
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            Info "installed: $ffmpegExe"
        } catch {
            Warn "ffmpeg download failed: $($_.Exception.Message)"
            Warn "download manually from https://ffmpeg.org/download.html and put ffmpeg.exe into: $FfmpegBin"
        }
    }
    if (Test-Path $FfmpegBin) { Save-UserEnv "ABV_FFMPEG_DIR" $FfmpegBin }
}

# ---------- HuggingFace cache ----------
$hfCache = if ($env:ABV_HF_CACHE) { $env:ABV_HF_CACHE } else { $HfCacheDefault }
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $hfCache | Out-Null }
Save-UserEnv "ABV_HF_CACHE" $hfCache

# ---------- Fun-ASR ----------
if (-not $SkipFunASR) {
    Step "Fun-ASR-Nano (needed only for audio transcription)"
    if ($env:ABV_FUNASR_SNAPSHOT -and (Test-Path $env:ABV_FUNASR_SNAPSHOT)) {
        Info "already configured: $env:ABV_FUNASR_SNAPSHOT"
    } elseif ($DryRun) {
        Info "would download FunAudioLLM/Fun-ASR-Nano-2512 into $hfCache"
    } else {
        try {
            Ensure-HfHub $python
            Info "downloading Fun-ASR-Nano (about 1.9GB)"
            $snap = Download-Snapshot $python "FunAudioLLM/Fun-ASR-Nano-2512" $hfCache
            Save-UserEnv "ABV_FUNASR_SNAPSHOT" $snap
        } catch {
            Warn "Fun-ASR download failed: $($_.Exception.Message)"
            Warn "transcription will be unavailable until ABV_FUNASR_SNAPSHOT is set"
        }
    }
}

# ---------- translation model ----------
if (-not $SkipTranslateModel) {
    Step "translation model (zh -> ja)"
    $repoDir = Join-Path $hfCache "models--shun89--opus-mt-zh-ja"
    if (Test-Path $repoDir) {
        Info "already present: $repoDir"
    } elseif ($DryRun) {
        Info "would download shun89/opus-mt-zh-ja into $hfCache"
    } else {
        try {
            Ensure-HfHub $python
            Info "downloading opus-mt-zh-ja (about 300MB)"
            Download-Snapshot $python "shun89/opus-mt-zh-ja" $hfCache | Out-Null
        } catch {
            Warn "translation model download failed: $($_.Exception.Message)"
            Warn "built-in zh->ja translation will fall back to Ollama or fail"
        }
    }
}

# ---------- check ----------
Step "environment check"
if ($DryRun) {
    Info "dry run finished"
    exit 0
}
$checkScript = Join-Path $ProjectRoot "tools\check_env.py"
if (Test-Path $checkScript) {
    & $python $checkScript
    $code = $LASTEXITCODE
} else {
    Warn "tools/check_env.py not found"
    $code = 0
}

Step "next steps"
Info "1. install GPT-SoVITS Python dependencies if you have not yet: see its README"
Info "2. start the engine (port 9880), then the backend (src/backend/app.py)"
Info "3. open http://127.0.0.1:8017"
Info "4. if paths are still wrong, open a new terminal so the saved environment variables take effect"
exit $code
