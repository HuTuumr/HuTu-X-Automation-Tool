"""本地模型连通性自检：验证 /v1/models 和 /v1/chat/completions，并打印一条样例草稿。

用法：
    python selftest.py
    python selftest.py --base http://127.0.0.1:1234/v1 --model "qwen/qwen3-4b"
"""
import argparse
import json
import random
import sys
import time
import urllib.request


def post(url, payload, api_key, timeout=120):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get(url, api_key, timeout=15):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:1234/v1")
    ap.add_argument("--key", default="lm-studio")
    ap.add_argument("--model", default="")
    ap.add_argument("--angle", default="", help="指定角度；留空则随机")
    args = ap.parse_args()
    base = args.base.rstrip("/")

    print(f"→ GET {base}/models")
    try:
        models = get(f"{base}/models", args.key)
    except Exception as e:
        print(f"  连接失败：{e}")
        print("  检查：LM Studio → Developer → Start Server 是否打开；端口是否一致。")
        return 1
    ids = [m.get("id") for m in models.get("data", [])]
    print(f"  在线模型：{ids}")
    model = args.model or (ids[0] if ids else "")
    if not model:
        print("  服务在线但没有已加载模型，先在 LM Studio 里 load 一个再试。")
        return 1

    angles = [
        "举一个反例或例外情况",
        "追问一个具体细节",
        "补充自己或身边人的真实经验",
        "轻微调侃这个说法",
        "指出被忽略的代价或前提",
        "换个立场反问一句",
    ]
    angle = args.angle or random.choice(angles)
    system = (
        "你是一名 X（Twitter）用户 @tester，正在刷时间线，看到一条推文，要写一条回复。\n"
        "你的身份与语气：普通 X 用户，语气自然、有自己的观点，偶尔幽默，不讨好任何人。\n\n"
        "写作要求：\n"
        "1. 只写一句回复，最多 40 个汉字或 25 个英文单词。\n"
        "2. 必须针对推文里的具体内容（某个观点、数字、例子、反问）作反应，不要写放之四海而皆准的话。\n"
        "3. 像真人随手打字：可以口语、可以有一点情绪或反问。\n"
        "4. 禁止：推销、放链接、加话题标签、自称 AI、空洞赞美（“说得太对了”“很有道理”“学习了”）。\n"
        "5. 不要用引号包裹，不要解释，只输出回复正文。\n"
        "6. 语言跟推文一致。\n"
        f"7. 这次从「{angle}」这个角度写。\n"
        "8. 开头不要用「这」「确实」「说真的」「说实话」。\n"
        "\n/no_think"
    )
    tweet_text = "AI 编程工具最近半年进步太快了，Cursor 和 Claude Code 已经能独立改完一个中等规模的 PR。"
    user = f'推文作者：@somebody\n推文内容：\n"""\n{tweet_text}\n"""'

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.9,
        "max_tokens": 160,
        "top_p": 0.9,
        "presence_penalty": 0.3,
        "frequency_penalty": 0.2,
        "stream": False,
    }

    print(f"→ POST {base}/chat/completions  model={model}")
    t0 = time.time()
    try:
        data = post(f"{base}/chat/completions", payload, args.key)
    except Exception as e:
        body = getattr(e, "read", lambda: b"")()
        print(f"  请求失败：{e}\n  {body[:400]}")
        return 1
    dt = time.time() - t0

    msg = (data.get("choices") or [{}])[0].get("message", {})
    print(f"  耗时 {dt:.2f}s")
    print(f"  token 用量: {data.get('usage')}")
    print(f"  原始 content: {msg.get('content')!r}")
    if msg.get("reasoning_content"):
        rc = msg["reasoning_content"]
        print(f"  reasoning 前 80 字: {rc[:80]!r}")
    print("\n样例草稿 ↓")
    print(msg.get("content", "").strip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
