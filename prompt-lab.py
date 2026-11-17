"""提示词实验台：用和扩展完全一致的规则跑样例，检查长度和口吻。

    python prompt-lab.py
    python prompt-lab.py --runs 3
"""
import argparse
import json
import re
import sys
import urllib.request

ANGLES = [
    "认同，并补一句自己的看法",
    "反驳或质疑",
    "追问一个具体细节",
    "补充一个别人没提到的点",
    "调侃一下",
    "表示惊讶",
]

PERSONA = "普通 X 用户，语气自然、有自己的观点，偶尔幽默，不讨好任何人。"
CARE_RE = "癌|肿瘤|化疗|放疗|手术|住院|确诊|复发|病危|重病|去世|走了|离世|过世|葬礼|自杀|抑郁|残疾|流产|家暴|车祸|地震|洪水|火灾|痊愈|康复"
CLICHES = ["值得注意的是", "总而言之", "不得不说", "这意味着", "深度分析", "总的来说", "值得深思", "综上所述"]

TWEETS = [
    ("somebody", "AI 编程工具最近半年进步太快了，Cursor 和 Claude Code 已经能独立改完一个中等规模的 PR。"),
    ("mariana", "当我试着修点东西，结果却把情况搞得更糟时哈哈哈哈哈哈哈"),
    ("ops", "今天又被算法限流了，发什么都没人看，这平台还能不能玩了"),
    ("pskcaglar1", "我妈妈战胜了癌症啊啊啊啊"),
]


def system_prompt(angle: str, care: bool, strict: bool = False) -> str:
    lines = [
        "你是一个真实的 X 平台用户，正在浏览帖子并参与讨论。",
        "",
        "根据原帖内容，生成一条自然、真实的中文评论。",
        "",
        "评论规则：",
        "1. 字数控制在 7-20 字，每次随机变化，不要固定长度。",
        "2. 必须紧扣原帖内容，像真人看完帖子后随口发表看法。",
        "3. 可以认同、反驳、质疑、提问、补充观点，也可以表达惊讶或调侃。",
        "4. 不要复述原帖，不要空洞地表达支持。",
        "5. 语言口语化，简洁自然，允许不完整句子，像真人聊天。",
        "6. 不要使用AI惯用表达，例如：值得注意的是、总而言之、不得不说、这意味着、深度分析。",
        "7. 不要每次都用相同句式，不要刻意总结或升华。",
        "8. 不要滥用感叹号、表情符号和问号。",
        "9. 根据原帖语气调整评论风格，严肃内容认真回应，轻松内容可以幽默。",
        "10. 如果原帖没有值得评论的内容，就提出一个自然且相关的问题。",
        "",
        f"【评论者的日常语气】{PERSONA}",
    ]
    if care:
        lines += [
            "",
            "【特别约束】原帖涉及疾病、生死、灾难或亲人。只写一句真诚、有分寸、善意的话；禁止调侃、质疑、阴阳怪气。",
        ]
    lines += [
        "",
        "输出要求：",
        "只输出一条评论，不要解释，不要加引号，不要输出其他内容。",
        "",
        f"这次的切入方式：{angle}",
    ]
    if strict:
        lines += ["", "【额外要求】必须点到原帖里出现过的一个具体词、数字或细节，否则算失败。"]
    lines += ["", "/no_think"]
    return "\n".join(lines)


def ask(base, model, system, user, key="lm-studio", temperature=0.85):
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "max_tokens": 80,
            "top_p": 0.9,
            "presence_penalty": 0.3,
            "frequency_penalty": 0.2,
            "stream": False,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read().decode("utf-8"))
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def limit_punct(text: str) -> str:
    """问号、感叹号各只留第一个，其余改逗号，句尾逗号去掉。"""
    q = e = 0
    out = []
    for ch in text:
        if ch in "？?":
            q += 1
            out.append("？" if q == 1 else "，")
        elif ch in "！!":
            e += 1
            out.append("！" if e == 1 else "，")
        else:
            out.append(ch)
    return "".join(out).rstrip("，,。 ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:1234/v1")
    ap.add_argument("--model", default="qwen3-4b")
    ap.add_argument("--runs", type=int, default=3)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    ok = 0
    total = 0
    for handle, tweet in TWEETS:
        care = bool(re.search(CARE_RE, tweet))
        print("\n===== @" + handle + "：" + tweet + ("  [敏感语境]" if care else ""))
        for i in range(args.runs):
            angle = ANGLES[(i + hash(handle)) % len(ANGLES)]
            sys_p = system_prompt(angle, care)
            user = f'原帖作者：@{handle}\n原帖内容：\n"""\n{tweet}\n"""'
            try:
                out = ask(base, args.model, sys_p, user)
            except Exception as e:
                print(f"  失败：{e}")
                continue
            out = limit_punct(out)
            n = len(out)
            flags = []
            if n < 7:
                flags.append("太短")
            if n > 20:
                flags.append("太长")
            if any(c in out for c in CLICHES):
                flags.append("AI腔")
            if out.count("？") + out.count("?") > 1:
                flags.append("问号多")
            total += 1
            if not flags:
                ok += 1
            print(f"  [{n:2d}字] {out}  {'<<< ' + '/'.join(flags) if flags else ''}")
    print(f"\n合规：{ok}/{total}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
