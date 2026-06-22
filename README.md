# llm-relay

### 仕組み

Claude Code を `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` でローカルルーターに向けます。
ルーターは各リクエストを見て、行き先を振り分けます。

```
Claude Code ──(ANTHROPIC_BASE_URL = 127.0.0.1:8787)──▶ llm-relay ルーター
   │
   ├─ リクエストの `system` に "RELAY-MODEL: <alias>" が含まれる？
   │
   ├─ あり → models.json で <alias> を引き、Authorization をそのプロバイダの鍵に差し替え
   │         ├─ "format": "openai" → Anthropic⇄OpenAI 変換し、base_url + /chat/completions へ POST
   │         └─ (format なし)        → model だけ書換、       base_url + /v1/messages へ POST（Anthropic ネイティブ）
   │
   └─ なし → 元の OAuth のまま api.anthropic.com へ素通し  ◀── これがメインセッション
```

- **メインセッション**（マーカー無し）は Anthropic へ透過中継。購読/OAuth はそのまま。
- **マーカー付きサブエージェント**は設定した外部プロバイダへ中継。
- **ストリーミング(SSE)** はそのまま流します。`format: "openai"` のときは OpenAI のチャンクを
  Anthropic の SSE イベント（`tool_use` デルタ含む）に変換します。
- **アイドル自殺**: 処理中リクエストが `RELAY_IDLE_MS`（既定20分）無ければ、ルーターは自動終了。

### 必要環境

- **Node.js 18 以上**（グローバル `fetch` / Web streams を使用。Node 24 で開発）。npm 依存ゼロ。
- **Claude Code CLI**。
- 起動スクリプト用の POSIX シェル（Windows は **Git Bash**）。

### Claude Code CLI への導入手順

**1. プロバイダ設定 — `models.json`**

```bash
cp llm-relay/models.json.example llm-relay/models.json
# その後 llm-relay/models.json を編集し、実際の鍵を入れる
```

`models.json` は鍵を含むため **gitignore 済**。絶対にコミットしないこと。

**2. Claude Code をルーターに向ける（毎セッション自動起動）**

`.claude/settings.local.json`（gitignore 済）に以下を追加。ここの `env` と `hooks` は
共有 `settings.json` と**マージ**されるので、他の設定は壊しません。

```json
{
  "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787" },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/llm-relay/src/start-router\" >/dev/null 2>&1 || true" }
        ]
      }
    ]
  }
}
```

> `ANTHROPIC_BASE_URL` は**プロセス起動時に一度だけ**読まれます。反映には**新しい** `claude`
> セッションを開始してください（既存セッションは中継されません）。

**3. 中継用サブエージェントを作る — `.claude/agents/<name>.md`**

```markdown
---
name: my-glm
description: "外部 glm-5.1 モデルで動く中継サブエージェント。"
model: sonnet
---

RELAY-MODEL: glm-5.1

あなたは ...（サブエージェントへの指示）
```

- **`model:` フロントマターは必須**です。無いと Claude Code がサブエージェントとして登録しません。
  値は何でも良い（ルーターが上書き）が、存在は必須です。
- **マーカー値**（`glm-5.1`）は `models.json` の `alias` と完全一致させること。

**4. 使う**

新しい `claude` セッションでサブエージェントを spawn（Task ツール）します。そのリクエストは
マーカーを運び、外部モデルへ中継されます。メインは Claude のまま。

### 手動 / ワンショット（常設設定なし）

```bash
bash llm-relay/src/start-router
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude -p "say hi"
```

`start-router` は冪等（二重起動しません）。

### `models.json` の書式

| 項目       | 必須 | 意味 |
|------------|------|------|
| `alias`    | ○ | マーカー `RELAY-MODEL: <alias>` に使う名前（一意に） |
| `model`    | ○ | プロバイダへ送るモデルID |
| `base_url` | ○ | プロバイダのベースURL（リクエストパスは**含めない**・下記参照） |
| `api_key`  | ○ | プロバイダの鍵。`Authorization: Bearer <api_key>` で送る |
| `format`   | × | `"openai"` で Anthropic⇄OpenAI 変換を有効化。Anthropic ネイティブなら省略 |

`base_url` にリクエストパスを**含めない**こと:

- **Anthropic ネイティブ**（`format` 省略）: ルーターが受信パス `/v1/messages` を連結。
  例 `https://openrouter.ai/api` → `https://openrouter.ai/api/v1/messages`
- **OpenAI**（`"format": "openai"`）: ルーターが `/chat/completions` を連結。
  例 `https://integrate.api.nvidia.com/v1` → `https://integrate.api.nvidia.com/v1/chat/completions`

どちらか分からない時は直叩きで判定: `/v1/messages` なら Anthropic ネイティブ、
`/v1/chat/completions` なら OpenAI（後者は `format: "openai"` を付ける）。

### 環境変数

| 変数            | 既定               | 意味 |
|-----------------|--------------------|------|
| `PORT`          | `8787`             | 待受ポート（127.0.0.1 のみ） |
| `RELAY_IDLE_MS` | `1200000`（20分）  | 処理中リクエストが無いままこの時間で自動終了 |

### 中継の確認

ルーターは**成功した中継はログに出しません**（エラー時のみ `console.warn`。`start-router` 経由なら
`llm-relay/router.log` に上流エラー等が残ります）。中継できているかは下の生HTTPテストで確認します:
`authorization: Bearer dummy`（デタラメな鍵）でも正しい外部応答が返れば中継成功の証拠です
— 中継されず Anthropic へ素通ししていれば、デタラメ鍵は 401 で弾かれるからです。

> サブエージェントの**返信テキスト**（合言葉など）だけを中継の証拠にしないこと（モデルが演技できる）。
> デタラメ鍵で正しい外部応答が返ること、が確実な証拠です。

Claude Code を介さない簡易テスト（ルーターが本物の鍵に差し替えるので `Bearer dummy` で可）:

```bash
curl -s http://127.0.0.1:8787/v1/messages \
  -H 'content-type: application/json' -H 'authorization: Bearer dummy' \
  -d '{"model":"x","max_tokens":32,"system":"RELAY-MODEL: glm-5.1","messages":[{"role":"user","content":"say relay-ok"}]}'
```

### セキュリティ

- 鍵は `models.json` のみ（gitignore 済）。ルーターは**鍵の値をログに出しません**。
- メインセッションの OAuth トークンは**変更せず**そのまま `api.anthropic.com` へ。
- 転送先は `models.json` の `base_url` か `api.anthropic.com` のみ。env を転送先に使わない（無限ループ防止）。

### 注意点

- `ANTHROPIC_BASE_URL` は起動時読込 → 中継は**新規セッション**にのみ適用。
- 中継用サブエージェントは `model:` フロントマター**必須**。
- OpenAI 形式のプロバイダは `format: "openai"` が**必要**。
- プロバイダ固有の癖: 遅い所がある（NVIDIA NIM 無料枠は ~30秒超/リクエスト）、推論にアカウントの
  権限/残高が要る所がある（`/models` は通るのに `403` = プロバイダ側で推論を有効化/残高追加）。
- OpenAI 形式では画像など text/tool 以外のコンテンツブロックは未変換（v1）。

### ファイル構成

```
llm-relay/
  src/router.mjs          ルーター本体（単一ファイル・依存ゼロ）
  src/openai-adapter.mjs  Anthropic⇄OpenAI 変換（リクエスト/応答/ストリーミング）
  src/start-router        冪等な起動スクリプト（Git Bash）
  models.json.example     雛形
  README.md               このファイル
```
