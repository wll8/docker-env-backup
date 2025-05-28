# Docker 环境备份和恢复工具

这是一个用于备份和恢复 Docker 环境的工具，提供两种实现方式：Shell 脚本和 Node.js 程序。您可以根据需求选择使用其中任一方式。

- 无停机备份
- 在 ubuntu 20 中测试过

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

## 实现方式一：Shell 脚本

### 环境要求

1. Bash 4.0 或更高版本
2. Docker 已安装并运行
3. root 权限

### 使用方法

1. 添加执行权限：
```bash
chmod +x backup_docker.sh
```

2. 运行脚本：
```bash
sudo ./backup_docker.sh
```

### Shell 脚本特性

- 交互式菜单界面
- 自动检查 Docker 服务状态
- 自动检查磁盘空间
- 支持选择性备份：
  - 备份特定 Docker 镜像
  - 备份容器配置
  - 备份 Docker 卷
  - 备份网络配置
  - 备份 Docker 配置文件
- 完整性验证：
  - 自动生成 SHA256 校验和
  - 备份后验证文件完整性
  - 记录备份时间戳
  - 保存 Docker 环境信息
- 安全特性：
  - 备份前检查权限
  - 备份前检查磁盘空间
  - 支持交互式确认
  - 自动处理容器状态

## 实现方式二：Node.js 程序

### 环境要求

1. Node.js 18.x 或更高版本
2. Docker 已安装并运行

### 安装

```bash
npm install
```

### 使用方法

#### 完整备份

备份整个 Docker 环境：
```bash
node docker_backup.js backup
```

#### 恢复环境

从备份恢复整个 Docker 环境：
```bash
node docker_backup.js restore
```

#### 查看备份内容

列出当前备份的内容：
```bash
node docker_backup.js list
```

#### 备份特定镜像

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

### Shell 脚本依赖
- bash
- docker
- coreutils

### Node.js 程序依赖
- dockerode: Docker API 客户端
- fs-extra: 文件系统操作
- tar: 文件打包
- commander: 命令行接口
- chalk: 控制台输出美化

## 许可证

MIT License
