# Docker 容器备份和恢复工具

这是一个支持跨操作系统恢复的 Docker 容器备份和恢复工具。它允许您备份 Docker 容器的配置和文件系统，并在需要时进行恢复。

## 功能特点

- 备份 Docker 容器的完整配置和文件系统
- 支持跨操作系统恢复
- 简单的命令行界面
- 备份列表管理
- 彩色输出提示

## 安装

1. 确保已安装 Node.js 和 Docker
2. 克隆此仓库
3. 安装依赖：

```bash
npm install
```

## 使用方法

### 备份容器

```bash
node index.js backup <containerId> <backupName>
```

例如：
```bash
node index.js backup abc123 my-container-backup
```

### 恢复容器

```bash
node index.js restore <backupName>
```

例如：
```bash
node index.js restore my-container-backup
```

### 列出所有备份

```bash
node index.js list
```

## 备份文件结构

备份文件存储在 `backups` 目录下，每个备份包含：

- `config.json`: 容器配置信息
- `container.tar`: 容器文件系统

## 注意事项

1. 确保有足够的磁盘空间进行备份
2. 备份过程中请勿修改容器
3. 恢复时请确保目标系统已安装相应的 Docker 镜像
4. 建议在恢复前备份重要数据

## 许可证

ISC
