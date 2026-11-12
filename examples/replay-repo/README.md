# replay-repo

`assets/demo.cast` 里那段录屏所用仓库的最小复现件。

`src/format.ts` 保存的是出错后的版本：日期用 `toISOString()` 直接拼，绕开了项目自己的
`formatDate()`。录屏里的仓库多一个已跟踪文件和一个新建文件，这里只保留最小的一份，
编译器和回放闸门的行为完全一样。

不要在这个目录里跑 `clamp init`：录屏用的快照 ref、hook 与约束文件会留在当前仓库。
把它复制到一个临时仓库再跑。

## 复现

```sh
export CLAMP_REPO=/path/to/clamp
demo="$(mktemp -d)/replay-repo"
mkdir -p "$demo/src"
cd "$demo"
git init -q -b main

# 1. 纠正之前的状态：日期走共享的 formatDate()
cat > src/format.ts <<'TS'
export function formatDate(value: Date): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, "0");
  const d = String(value.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
TS
git add -A && git commit -qm "format a date"

# 2. agent 把它改成了 toISOString()
cp "$CLAMP_REPO/examples/replay-repo/src/format.ts" src/format.ts

# 3. 记下坏状态。快照包含未跟踪的新文件，不动工作区
clamp init
clamp fix --words "时间别自己拼，统一用 formatDate"

# 4. 按提示把 src/format.ts 改回上面第 1 步的版本，然后编译这次纠正
clamp compile <上一步打印的 snapshot id>

# 5. 再犯同类错误时，提交会被 pre-commit 挡住（hook 以 exit 2 结束）
```

`clamp fix` 在最小仓库上的真实输出：

```text
snapshot refs/clamp/bad/c78d · 1 added line
  src/format.ts:2  return value.toISOString();
after fixing the code, run: clamp compile c78d
```

`clamp compile` 通过三关后打印落盘路径：

```text
candidate 0001-no-raw-toisostring  span  src/**/*.ts  /\.toISOString\(\)/
content_check  /\.toISOString\(\)/  (PreToolUse, before the write)
tree_check     git grep --untracked -nE '\.toISOString\(\)' -- ':(glob)src/**/*.ts'  (expect: no_match, 30s)
replay    fires_on_bad yes · passes_on_good yes · baseline 1 commit · 0 blocks · 0 trigger hits
written   .clamp/constraints/0001-no-raw-toisostring.yaml
```

快照 id 由 tree 的哈希得出，内容相同时可重现；约束的 `version` 含创建时间，每次编译
都会不同。
