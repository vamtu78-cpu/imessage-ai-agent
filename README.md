# iMessage Companion

用 [Photon](https://photon.codes) 的云端 iMessage 中转 + 任意 OpenAI 兼容的 LLM，让一个 AI 人格通过 iMessage 主动跟你聊天、发语音、发表情包、过一会儿追问你。不需要 Mac，不需要越狱，一台普通 Linux VPS 就够。

## 能干嘛

- 你发短信过去，它用你设定的人格回复（记住这次对话的上下文）
- 回复里可以插入 `[voice]文字` 转成语音发送
- 可以插入 `[img:标签]` 发表情包（自己配置图库）
- 可以插入 `[delay:15]文字`，15 分钟后再发这一行——用来主动追问
- 配合 cron 可以让它自己找你聊天，不用你先开口

## 前置准备

- 一台 Linux VPS（Ubuntu 22.04/24.04），有 root，2 核 2G 完全够用
- Node.js 20+，`ffmpeg`（语音功能需要转码）
- 一个 [Photon](https://photon.codes) 账号（免费层可用）
- 一个 LLM 的 API key（官方或中转都行，只要是 OpenAI 兼容的 `/chat/completions`）

## 搭建步骤

### 1. 建 Photon 项目，拿到号码和凭据

```bash
npx @photon-ai/cli login
npx @photon-ai/cli projects create --name my-companion --platforms imessage --json
# 记下上面返回的 id，然后：
PHOTON_PROJECT_ID=<刚才的id> npx @photon-ai/cli spectrum platforms enable imessage
npx @photon-ai/cli projects ls --json   # 拿 PROJECT_ID / PROJECT_SECRET
```

在 Photon 控制台（app.photon.codes）能看到这个项目分配到的专属号码。**用你自己的手机先往这个号码发一条任意短信**——Photon 的路由是按"这个号码第一次联系了哪个项目"绑定的，不发这一步，项目永远收不到你的消息。

### 2. 配置

```bash
git clone <this repo>
cd imessage-companion
npm install
cp .env.example .env        # 填入上一步的 PROJECT_ID / PROJECT_SECRET，你的手机号，relay 信息
cp persona.example.txt persona.txt   # 改成你想要的人格设定
```

想要表情包功能：`cp stickers.example.json stickers.json`，填自己的图床链接。不想要就不用建这个文件。

### 3. 跑起来

```bash
node --env-file=.env node_modules/.bin/tsx src/index.ts
```

给 `.env` 里配置的那个手机号发条消息，应该几秒内收到人格化的回复。

### 4. 常驻部署（可选）

`deploy/imessage-companion.service.example` 是个 systemd unit 模板，改改路径复制到 `/etc/systemd/system/` 就能用 `systemctl enable --now` 常驻跑。

想要它自己主动找你聊，`spontaneous_send.mjs` 配合 `deploy/spontaneous-imessage.cron.example`（改成 `/etc/cron.d/` 下的文件）——注意服务器一般是 UTC 时区，cron 表达式要按自己的时区换算。

## 已知限制

- **`voice()` 在 Photon 的 iMessage 中转上是坏的**：`spectrum-ts` 提供了专门生成原生语音气泡的 `voice()` 内容类型，但发出去的消息会显示成一个 `00:00`、点不开的死气泡（发出去的音频文件本身完全没问题，自己验证过是标准 AAC）。这里改用通用文件附件 `attachment()` 传同一份音频——外观是个文件框而不是波形气泡，但实际能播放。如果哪天 Photon 修复了这个问题，把 `sendVoiceLine` 里的 `attachment()` 换回 `voice()` 就行。
- **延迟消息（`[delay:]`）是纯内存计时器**，进程重启（发版、崩溃）会丢失还没触发的延迟消息，没有持久化队列。这种"随手一句"的场景够用；要保证必达得自己加一张表定期扫描。
- **某些 relay/中转的模型渠道可能不是裸模型**：如果发现某个模型渠道死活不肯扮演你设定的人格、总是自称别的产品名，大概率是那个渠道背后代理了一个带自己身份的 Agent 产品，换个渠道测一下，不是你的 prompt 有问题。
- 免费层的 Photon 项目**不能对从没联系过的号码冷启动发送**（会报 `Target not allowed for this project`）——必须先有对方发来的一条消息建立绑定，才能反向主动发送。

## 养多个人格

每个 Photon 项目会自动分配一个独立的号码（不是全账号共用一个），所以想要好几个不同人格的联系人，重复"搭建步骤"建新项目就行，代码原样复制一份，换个 `.env`、换个 `persona.txt`，是完全独立的两个 iMessage 联系人。

## License

MIT
