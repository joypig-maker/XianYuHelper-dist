# -*- coding: utf-8 -*-
"""把插件目录打包成 zip（便于备份 / 发送给他人解压后加载）"""
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {'.git', '.workbuddy', '__pycache__', 'dist', 'node_modules'}
OUT = os.path.join(ROOT, 'dist')


def main():
    os.makedirs(OUT, exist_ok=True)
    version = '1.0.0'
    try:
        import json
        with open(os.path.join(ROOT, 'manifest.json'), encoding='utf-8') as f:
            version = json.load(f).get('version', version)
    except Exception:
        pass
    target = os.path.join(OUT, 'xianyu-helper-v%s.zip' % version)

    count = 0
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(ROOT):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
            for name in files:
                if name.endswith(('.pyc', '.zip', '.crx', '.pem')):
                    continue
                full = os.path.join(root, name)
                rel = os.path.relpath(full, ROOT).replace('\\', '/')
                z.write(full, rel)
                count += 1
    print('已打包 %d 个文件 -> %s' % (count, target))


if __name__ == '__main__':
    main()
