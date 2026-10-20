#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
重新生成启动器内嵌的展示字体子集（ZCOOL QingKe HuangYou，OFL）。

源字体获取方式（任选其一）：
  1) 直接给 TTF/WOFF 路径：python assets\make-font-subset.py "D:\path\zcool-full.ttf"
  2) 本地离线包：设置环境变量 ABV_FONT_TGZ 指向字体压缩包
     解压后取 package/files/zcool-qingke-huangyou-chinese-simplified-400-normal.woff
     （fontTools 能直接读取 woff，无需额外依赖）
  3) 若源字体为 woff2，需要额外安装 brotli：pip install brotli

产物：assets/ZCOOLQingKeHuangYou-subset.ttf.gz（build.bat 会把它嵌入 exe）
字符集 = launcher.cs 里出现的全部字符 ∪ ASCII 可打印字符 ∪ GB2312 一级常用字（3755）
"""
import gzip
import os
import sys

from fontTools import subset

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER_CS = os.path.join(os.path.dirname(HERE), "launcher.cs")
OUT_GZ = os.path.join(HERE, "ZCOOLQingKeHuangYou-subset.ttf.gz")

CANDIDATES = [
    os.path.join(HERE, "ZCOOLQingKeHuangYou.ttf"),
    os.path.join(os.environ.get("TEMP", ""), "abv-v4-launcher", "zcool-full.ttf"),
    os.environ.get("ABV_FONT_TGZ", ""),
]

GB2312_LEVEL1 = set()
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            ch = bytes([hi, lo]).decode("gb2312")
        except UnicodeDecodeError:
            continue
        if "\u4e00" <= ch <= "\u9fff":
            GB2312_LEVEL1.add(ch)


def find_source():
    if len(sys.argv) > 1:
        return sys.argv[1]
    for p in CANDIDATES:
        if p and os.path.isfile(p):
            return p
    sys.exit("source font not found; pass a path argument (see docstring)")


def main():
    src = find_source()
    print("source:", src)
    if not os.path.isfile(LAUNCHER_CS):
        sys.exit("missing launcher source: " + LAUNCHER_CS)

    with open(LAUNCHER_CS, encoding="utf-8") as f:
        source = f.read()
    used = {ch for ch in source if ord(ch) > 127}

    ascii_chars = {chr(c) for c in range(0x20, 0x7F)}
    cjk_punct = set("　、。，．·「」『』（）【】《》〈〉—…“”‘’～！？：；／＼＋－×÷＝％＃＆＊＠｜§※★☆♪→←↑↓●○◎◆◇■□▲△▼▽")
    chars = used | ascii_chars | cjk_punct | GB2312_LEVEL1

    opts = subset.Options()
    opts.layout_features = ["*"]
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["DSIG"]

    font = subset.load_font(src, opts)
    subsetter = subset.Subsetter(options=opts)
    subsetter.populate(text="".join(sorted(chars)))
    subsetter.subset(font)

    tmp_ttf = os.path.join(HERE, "_subset_tmp.ttf")
    font.save(tmp_ttf)
    with open(tmp_ttf, "rb") as f:
        raw = f.read()
    os.remove(tmp_ttf)
    with open(OUT_GZ, "wb") as f:
        f.write(gzip.compress(raw, 9))

    print("chars:", len(chars))
    print("subset ttf:", len(raw), "bytes")
    print("gzip:", os.path.getsize(OUT_GZ), "bytes ->", OUT_GZ)


if __name__ == "__main__":
    main()
