# 在不同电脑上编辑项目

GitHub 仓库用于同步源代码和保留修改历史。每台电脑的交易账本、BUFF 登录与运行设置保存在自己的 `data/` 目录，不随代码上传。演示数据、环境密钥、浏览器登录目录和运行截图也已排除。

仓库地址：<https://github.com/TempleOne64/smis-buff-procurement>

## 首次使用另一台 Windows 电脑

1. 安装 Git 与 Node.js 24，并登录有权访问该仓库的 GitHub 账号。也可使用 GitHub Desktop 登录并克隆仓库。
2. 在仓库网页点击 `Code`，复制 HTTPS 地址。用 GitHub Desktop 克隆，或在终端执行 `git clone 仓库地址`（把“仓库地址”替换为复制的地址）。
3. 在 Codex 或编辑器中打开克隆得到的整个项目目录。
4. 双击 `setup.cmd` 安装浏览器组件，然后双击 `start.cmd`，访问 `http://127.0.0.1:8769`。
5. 新电脑首次运行时重新登录 BUFF，并设置目标 Steam ID、采购条件和自动采购选项。

## 切换电脑的顺序

开始编辑前，在项目目录执行：

```powershell
git pull --ff-only
```

修改完成后：

```powershell
git add .
git commit -m "说明本次修改"
git push
```

换到另一台电脑，再执行 `git pull --ff-only`。也可以使用 GitHub Desktop 的 Pull、Commit 和 Push 完成同样操作。换电脑前先推送，开始编辑前先拉取，可以减少两台电脑改动冲突。

如果 Git 首次提交提示未配置姓名或邮箱，可通过 GitHub Desktop 配置，或在该项目目录设置 `git config user.name` 和 `git config user.email`，使用你自己的 GitHub 提交身份。

## 本地运行数据

GitHub 不会带走已有的采购记录、账本和登录。需要迁移账本时，应关闭程序后另行备份 `data/funding.sqlite`，不要把 `data/buff-profile` 登录资料提交到仓库。继续操作已有订单时，先在目标电脑核对平台订单与本地记录。
