# Docker 环境备份和恢复工具

这是一个用于备份和恢复 Docker 环境的命令行工具。它可以备份 Docker 镜像、容器、网络、卷和文件映射，并在需要时进行恢复。

## 功能特点

- 完整备份 Docker 环境
  - 备份所有 Docker 镜像
  - 备份所有容器及其配置
  - 备份所有网络配置
  - 备份所有卷数据
  - 备份所有文件映射
  - 保存 Docker 环境信息

- 选择性备份
  - 支持备份特定镜像及其相关容器
  - 保持镜像标签和仓库信息

- 完整性验证
  - 计算备份文件的 SHA256 校验和
  - 保存备份时间戳
  - 记录 Docker 环境信息

- 安全恢复
  - 支持完整环境恢复
  - 自动处理文件映射
  - 保持文件权限和属性
  - 自动处理冲突

## 安装

### 环境要求

1. 安装 NVM（Node Version Manager）
```bash
# 设置 NVM 镜像（如果遇到下载问题）
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
export NVM_IOJS_ORG_MIRROR=https://npmmirror.com/mirrors/iojs/

# 安装 NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# 配置 NVM 环境变量
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # 加载 nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # 加载 nvm bash_completion

# 验证安装
nvm --version
```

2. 使用 NVM 安装 Node.js
```bash
# 安装最新的 LTS 版本
nvm install --lts

# 使用已安装的版本
nvm use --lts

# 验证 Node.js 安装
node --version
npm --version
```

### 故障排除

如果遇到 SSL 连接问题，可以尝试以下解决方案：

1. 使用国内镜像源：
```bash
export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
export NVM_IOJS_ORG_MIRROR=https://npmmirror.com/mirrors/iojs/
```

2. 更新 SSL 证书：
```bash
apt-get update
apt-get install -y ca-certificates
update-ca-certificates
```

3. 使用 NodeSource 仓库：
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get install -y nodejs
```

3. 安装项目依赖
```bash
npm install
```

## 使用方法

### 完整备份

备份整个 Docker 环境：
```bash
node docker_backup.js backup
```

### 恢复环境

从备份恢复整个 Docker 环境：
```bash
node docker_backup.js restore
```

### 查看备份内容

列出当前备份的内容：
```bash
node docker_backup.js list
```

### 备份特定镜像

备份特定镜像及其相关容器：
```bash
node docker_backup.js backup-image <imageName>
```
例如：
```bash
node docker_backup.js backup-image nginx:latest
```

## 备份内容说明

备份文件保存在 `backups` 目录下，包含以下内容：

- `images/`: 镜像备份
  - `*.json`: 镜像配置信息
  - `*.tar`: 镜像数据
  - `mappings.json`: 镜像标签映射

- `containers/`: 容器备份
  - `*.json`: 容器配置信息
  - `*.tar`: 容器文件系统

- `networks/`: 网络备份
  - `*.json`: 网络配置信息

- `volumes/`: 卷备份
  - `*.json`: 卷配置信息
  - `*.tar`: 卷数据

- `fs/`: 文件系统备份
  - `volumes/`: 卷文件系统备份
  - `binds/`: 文件映射备份

- `docker_info.json`: Docker 环境信息
- `docker_version.json`: Docker 版本信息
- `backup_timestamp.txt`: 备份时间戳
- `checksums.json`: 文件校验和

## 注意事项

1. 备份前请确保有足够的磁盘空间
2. 恢复前请确保目标环境有足够的资源
3. 文件映射的恢复需要确保目标路径存在
4. 建议在恢复前备份当前环境

## 错误处理

工具会在遇到错误时提供详细的错误信息，包括：
- 文件操作错误
- Docker API 错误
- 权限错误
- 资源不足错误

## 依赖项

- dockerode: Docker API 客户端
- fs-extra: 文件系统操作
- tar: 文件打包
- commander: 命令行接口
- chalk: 控制台输出美化

## 许可证

MIT License
