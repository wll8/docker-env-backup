#!/usr/bin/env node

const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');
const tar = require('tar');
const { program } = require('commander');
const chalk = require('chalk');
const crypto = require('crypto');
const yaml = require('js-yaml');
const dotenv = require('dotenv');
const { execSync } = require('child_process');

const docker = new Docker();

// 创建备份目录
const BACKUP_DIR = path.join(process.cwd(), 'backups');
fs.ensureDirSync(BACKUP_DIR);

// 计算文件 SHA256
async function calculateSHA256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// 验证备份
async function verifyBackup() {
  try {
    // 记录 Docker 环境信息
    const dockerInfo = await docker.info();
    await fs.writeJson(path.join(BACKUP_DIR, 'docker_info.json'), dockerInfo);

    const dockerVersion = await docker.version();
    await fs.writeJson(path.join(BACKUP_DIR, 'docker_version.json'), dockerVersion);

    // 记录备份时间戳
    await fs.writeFile(
      path.join(BACKUP_DIR, 'backup_timestamp.txt'),
      `备份时间: ${new Date().toISOString()}`
    );

    // 计算所有文件的校验和
    const checksums = {};
    const files = await fs.readdir(BACKUP_DIR);
    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stats = await fs.stat(filePath);
      if (stats.isFile() && file !== 'checksums.json') {
        checksums[file] = await calculateSHA256(filePath);
      }
    }

    await fs.writeJson(path.join(BACKUP_DIR, 'checksums.json'), checksums);
    console.log(chalk.green('备份验证完成'));
  } catch (error) {
    console.error(chalk.red(`备份验证失败: ${error.message}`));
    throw error;
  }
}

// 备份 Docker 镜像
async function backupImages(specificImages = null) {
  try {
    const images = specificImages || await docker.listImages();
    const imagesDir = path.join(BACKUP_DIR, 'images');
    fs.ensureDirSync(imagesDir);

    // 创建映射关系文件
    const imageMappings = {};

    console.log(chalk.blue(`找到 ${images.length} 个镜像`));
    for (const image of images) {
      const imageId = image.Id;
      console.log(chalk.blue(`正在备份镜像: ${imageId}`));

      // 保存镜像配置
      await fs.writeJson(
        path.join(imagesDir, `${imageId}.json`),
        image,
        { spaces: 2 }
      );

      // 保存镜像数据
      const imageStream = await docker.getImage(imageId).get();
      const imageTarPath = path.join(imagesDir, `${imageId}.tar`);
      const writeStream = fs.createWriteStream(imageTarPath);

      await new Promise((resolve, reject) => {
        imageStream.pipe(writeStream)
          .on('finish', resolve)
          .on('error', reject);
      });

      // 记录映射关系
      if (image.RepoTags) {
        imageMappings[imageId] = {
          repoTags: image.RepoTags,
          repoDigests: image.RepoDigests || []
        };
      }
    }

    // 保存映射关系
    await fs.writeJson(
      path.join(imagesDir, 'mappings.json'),
      imageMappings,
      { spaces: 2 }
    );

    console.log(chalk.green('所有镜像备份完成'));
  } catch (error) {
    console.error(chalk.red(`备份镜像失败: ${error.message}`));
    throw error;
  }
}

// 备份 Docker 网络
async function backupNetworks(specificNetworks = null) {
  try {
    const networks = specificNetworks || await docker.listNetworks();
    const networksDir = path.join(BACKUP_DIR, 'networks');
    fs.ensureDirSync(networksDir);

    console.log(chalk.blue(`找到 ${networks.length} 个网络`));
    for (const network of networks) {
      // 跳过默认网络
      if (network.Name === 'bridge' || 
          network.Name === 'host' || 
          network.Name === 'none' ||
          network.Name.startsWith('docker-') ||
          network.Name.startsWith('com.docker.')) {
        console.log(chalk.yellow(`跳过默认网络: ${network.Name}`));
        continue;
      }

      console.log(chalk.blue(`正在备份网络: ${network.Name}`));
      await fs.writeJson(
        path.join(networksDir, `${network.Name}.json`),
        network
      );
    }
    console.log(chalk.green('所有网络备份完成'));
  } catch (error) {
    console.error(chalk.red(`备份网络失败: ${error.message}`));
    throw error;
  }
}

// 备份 Docker 配置
async function backupConfig() {
  try {
    const configDir = path.join(BACKUP_DIR, 'config');
    fs.ensureDirSync(configDir);

    // 备份 Docker 守护进程配置
    const dockerInfo = await docker.info();
    await fs.writeJson(path.join(configDir, 'daemon.json'), {
      info: dockerInfo,
      version: await docker.version()
    });

    console.log(chalk.green('Docker 配置备份完成'));
  } catch (error) {
    console.error(chalk.red(`备份配置失败: ${error.message}`));
    throw error;
  }
}

// 确保 Alpine 镜像存在
async function ensureAlpineImage() {
  try {
    try {
      await docker.getImage('alpine:latest').inspect();
      console.log(chalk.green('Alpine 镜像已存在'));
    } catch (error) {
      if (error.statusCode === 404) {
        console.log(chalk.blue('正在拉取 Alpine 镜像...'));
        await docker.pull('alpine:latest');
        console.log(chalk.green('Alpine 镜像拉取成功'));
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error(chalk.red(`确保 Alpine 镜像存在失败: ${error.message}`));
    throw error;
  }
}

// 备份卷
async function backupVolume(volumeName) {
  try {
    // 确保备份目录存在
    const volumesDir = path.join(BACKUP_DIR, 'volumes');
    fs.ensureDirSync(volumesDir);

    // 确保 Alpine 镜像存在
    await ensureAlpineImage();

    const volume = docker.getVolume(volumeName);
    const volumeInfo = await volume.inspect();

    // 创建临时容器来访问卷
    const tempContainer = await docker.createContainer({
      Image: 'alpine:latest',
      name: `temp-volume-backup-${Date.now()}`,
      Cmd: ['sh', '-c', 'sleep 3600'],
      HostConfig: {
        Binds: [`${volumeName}:/volume-data`]
      }
    });

    await tempContainer.start();

    // 导出卷数据
    const tarStream = await tempContainer.getArchive({
      path: '/volume-data'
    });

    // 保存卷数据到 volumes 目录
    const volumeTarPath = path.join(volumesDir, `${volumeInfo.Name}.tar`);
    const writeStream = fs.createWriteStream(volumeTarPath);

    await new Promise((resolve, reject) => {
      tarStream.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 保存卷配置
    const volumeConfigPath = path.join(volumesDir, `${volumeInfo.Name}.json`);
    await fs.writeJson(volumeConfigPath, volumeInfo, { spaces: 2 });

    // 创建卷内容的文件系统备份
    const volumeFsPath = path.join(volumesDir, 'fs', 'volumes', volumeInfo.Name);
    fs.ensureDirSync(volumeFsPath);

    // 从 tar 文件中提取内容到文件系统，保持所有属性
    await new Promise((resolve, reject) => {
      const extractStream = tar.extract({
        cwd: volumeFsPath,
        preservePaths: true,
        preserveOwner: true,
        preserveMode: true,
        preserveTimestamps: true,
        strict: true
      });
      fs.createReadStream(volumeTarPath)
        .pipe(extractStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 清理临时容器
    await tempContainer.stop();
    await tempContainer.remove();

    console.log(chalk.green(`卷 ${volumeName} 已成功备份到文件系统`));
  } catch (error) {
    console.error(chalk.red(`备份卷 ${volumeName} 失败: ${error.message}`));
    throw error;
  }
}

// 备份容器
async function backupContainer(containerId) {
  try {
    const container = docker.getContainer(containerId);
    const containerInfo = await container.inspect();

    // 创建备份目录
    const containersDir = path.join(BACKUP_DIR, 'containers');
    fs.ensureDirSync(containersDir);

    // 导出完整的容器配置
    await fs.writeJson(
      path.join(containersDir, `${containerId}.json`),
      containerInfo,
      { spaces: 2 }
    );

    // 导出容器文件系统
    const tarStream = await container.export();
    const tarPath = path.join(containersDir, `${containerId}.tar`);
    const writeStream = fs.createWriteStream(tarPath);

    await new Promise((resolve, reject) => {
      tarStream.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 备份所有关联的卷
    const volumes = containerInfo.Mounts
      .filter(mount => mount.Type === 'volume')
      .map(mount => mount.Name);

    if (volumes.length > 0) {
      console.log(chalk.blue(`正在备份 ${volumes.length} 个关联卷...`));
      for (const volumeName of volumes) {
        await backupVolume(volumeName);
      }
    }

    // 备份文件映射
    const binds = containerInfo.HostConfig?.Binds || [];
    if (binds.length > 0) {
      console.log(chalk.blue(`正在备份 ${binds.length} 个文件映射...`));
      const bindFsPath = path.join(BACKUP_DIR, 'fs', 'binds', containerId);
      fs.ensureDirSync(bindFsPath);

      // 用于跟踪已备份的文件名，避免冲突
      const backupNames = new Map();

      for (const bind of binds) {
        const [hostPath, containerPath] = bind.split(':');
        if (fs.existsSync(hostPath)) {
          const stats = await fs.stat(hostPath);
          const originalName = path.basename(hostPath);
          
          // 生成唯一的备份文件名
          let backupName = originalName;
          let counter = 1;
          while (backupNames.has(backupName)) {
            const ext = path.extname(originalName);
            const base = path.basename(originalName, ext);
            backupName = `${base}_${counter}${ext}`;
            counter++;
          }
          backupNames.set(backupName, true);

          const bindBackupPath = path.join(bindFsPath, backupName);
          
          // 保存文件/目录的元数据
          await fs.writeJson(
            `${bindBackupPath}.metadata.json`,
            {
              isFile: stats.isFile(),
              isDirectory: stats.isDirectory(),
              mode: stats.mode,
              uid: stats.uid,
              gid: stats.gid,
              mtime: stats.mtime,
              containerPath: containerPath,
              hostPath: hostPath,
              originalName: originalName
            },
            { spaces: 2 }
          );

          if (stats.isFile()) {
            // 如果是文件，直接复制并保持原始扩展名
            await fs.copy(hostPath, bindBackupPath);
            console.log(chalk.blue(`已备份文件映射: ${hostPath} -> ${containerPath}`));
          } else if (stats.isDirectory()) {
            // 如果是目录，使用 tar 备份
            await tar.create(
              {
                gzip: false,
                file: `${bindBackupPath}.tar`,
                preservePaths: true,
                preserveOwner: true,
                preserveMode: true,
                preserveTimestamps: true,
                cwd: path.dirname(hostPath)
              },
              [path.basename(hostPath)]
            );
            console.log(chalk.blue(`已备份目录映射: ${hostPath} -> ${containerPath}`));
          }
        }
      }
    }

    console.log(chalk.green(`容器 ${containerId} 已成功备份`));
  } catch (error) {
    console.error(chalk.red(`备份失败: ${error.message}`));
    throw error;
  }
}

// 备份所有容器
async function backupAllContainers() {
  try {
    const containers = await docker.listContainers({ all: true });
    console.log(chalk.blue(`找到 ${containers.length} 个容器`));

    for (const container of containers) {
      const containerName = container.Names[0].replace('/', '');
      console.log(chalk.blue(`正在备份容器: ${containerName}`));
      await backupContainer(container.Id);
    }

    console.log(chalk.green(`所有容器已成功备份`));
  } catch (error) {
    console.error(chalk.red(`备份所有容器失败: ${error.message}`));
    throw error;
  }
}

// 执行完整备份
async function performFullBackup() {
  try {
    console.log(chalk.blue('开始完整备份...'));

    // 创建文件系统备份目录
    const fsBackupDir = path.join(BACKUP_DIR, 'fs');
    fs.ensureDirSync(path.join(fsBackupDir, 'volumes'));
    fs.ensureDirSync(path.join(fsBackupDir, 'binds'));

    // 备份镜像
    await backupImages();

    // 备份网络
    await backupNetworks();

    // 备份配置
    await backupConfig();

    // 备份容器
    await backupAllContainers();

    // 验证备份
    await verifyBackup();

    console.log(chalk.green(`完整备份已完成，保存在: ${BACKUP_DIR}`));
  } catch (error) {
    console.error(chalk.red(`完整备份失败: ${error.message}`));
    throw error;
  }
}

// 恢复卷
async function restoreVolume(volumeName) {
  try {
    // 确保 Alpine 镜像存在
    await ensureAlpineImage();

    const volumeConfigPath = path.join(BACKUP_DIR, 'volumes', `${volumeName}.json`);
    const volumeTarPath = path.join(BACKUP_DIR, 'volumes', `${volumeName}.tar`);
    const volumeFsPath = path.join(BACKUP_DIR, 'fs', 'volumes', volumeName);

    if (!fs.existsSync(volumeConfigPath) || !fs.existsSync(volumeTarPath)) {
      throw new Error(`卷 ${volumeName} 的备份文件不完整`);
    }

    const volumeConfig = await fs.readJson(volumeConfigPath);

    // 创建新卷
    const volume = await docker.createVolume({
      Name: volumeName,
      Driver: volumeConfig.Driver,
      Labels: volumeConfig.Labels,
      DriverOpts: volumeConfig.Options
    });

    // 创建临时容器来恢复卷数据
    const tempContainer = await docker.createContainer({
      Image: 'alpine:latest',
      name: `temp-volume-restore-${Date.now()}`,
      Cmd: ['sh', '-c', 'sleep 3600'],
      HostConfig: {
        Binds: [`${volumeName}:/volume-data`]
      }
    });

    await tempContainer.start();

    // 如果存在文件系统备份，优先使用文件系统备份
    if (fs.existsSync(volumeFsPath)) {
      console.log(chalk.blue(`正在从文件系统恢复卷 ${volumeName} 的内容...`));
      // 创建临时 tar 文件，保持所有属性
      const tempTarPath = path.join(BACKUP_DIR, 'volumes', `${volumeName}-temp.tar`);
      await tar.create(
        {
          gzip: false,
          file: tempTarPath,
          preservePaths: true,
          preserveOwner: true,
          preserveMode: true,
          preserveTimestamps: true,
          cwd: volumeFsPath
        },
        ['.']
      );

      // 导入卷数据
      const tarStream = fs.createReadStream(tempTarPath);
      await tempContainer.putArchive(tarStream, {
        path: '/'
      });

      // 清理临时文件
      await fs.remove(tempTarPath);
    } else {
      // 使用原始 tar 文件
      console.log(chalk.blue(`正在从 tar 文件恢复卷 ${volumeName} 的内容...`));
      const tarStream = fs.createReadStream(volumeTarPath);
      await tempContainer.putArchive(tarStream, {
        path: '/'
      });
    }

    // 清理临时容器
    await tempContainer.stop();
    await tempContainer.remove();

    console.log(chalk.green(`卷 ${volumeName} 已成功恢复`));
  } catch (error) {
    console.error(chalk.red(`恢复卷 ${volumeName} 失败: ${error.message}`));
    throw error;
  }
}

// 恢复容器
async function restoreContainer(containerId) {
  try {
    const configPath = path.join(BACKUP_DIR, 'containers', `${containerId}.json`);
    const tarPath = path.join(BACKUP_DIR, 'containers', `${containerId}.tar`);
    const bindFsPath = path.join(BACKUP_DIR, 'fs', 'binds', containerId);

    // 检查备份文件是否存在
    if (!fs.existsSync(configPath) || !fs.existsSync(tarPath)) {
      throw new Error('备份文件不完整');
    }

    // 读取完整的容器配置
    const containerInfo = await fs.readJson(configPath);
    if (!containerInfo || !containerInfo.Config) {
      throw new Error('容器配置数据无效');
    }

    // 检查是否存在同名容器，如果存在则删除
    try {
      const existingContainer = docker.getContainer(containerInfo.Name.replace('/', ''));
      const existingInfo = await existingContainer.inspect();
      console.log(chalk.yellow(`发现同名容器 ${containerInfo.Name}，正在删除...`));
      
      // 无论容器状态如何，都尝试停止和删除
      try {
        await existingContainer.stop();
      } catch (stopError) {
        // 忽略停止错误，继续尝试删除
        console.log(chalk.yellow(`容器 ${containerInfo.Name} 可能已经停止`));
      }
      
      try {
        await existingContainer.remove({ force: true });
      } catch (removeError) {
        // 如果删除失败，抛出错误
        throw new Error(`无法删除容器 ${containerInfo.Name}: ${removeError.message}`);
      }
      
      console.log(chalk.green(`已删除同名容器 ${containerInfo.Name}`));
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }

    // 检查镜像是否存在
    const imageName = containerInfo.Config.Image;
    try {
      await docker.getImage(imageName).inspect();
      console.log(chalk.green(`镜像 ${imageName} 已存在`));
    } catch (error) {
      if (error.statusCode === 404) {
        console.log(chalk.yellow(`镜像 ${imageName} 不存在，尝试从备份恢复...`));
        await restoreImages();
      } else {
        throw error;
      }
    }

    // 恢复关联的卷
    const volumesDir = path.join(BACKUP_DIR, 'volumes');
    if (fs.existsSync(volumesDir)) {
      const volumeFiles = await fs.readdir(volumesDir);
      const volumeBackups = volumeFiles.filter(file => file.endsWith('.json'));

      if (volumeBackups.length > 0) {
        console.log(chalk.blue(`正在恢复 ${volumeBackups.length} 个关联卷...`));
        for (const volumeConfigFile of volumeBackups) {
          const volumeName = volumeConfigFile.replace('.json', '');
          await restoreVolume(volumeName);
        }
      }
    }

    // 准备容器配置
    const containerConfig = {
      ...containerInfo.Config,
      name: containerInfo.Name.replace('/', ''),
      HostConfig: containerInfo.HostConfig,
      NetworkingConfig: containerInfo.NetworkSettings.Networks
    };

    // 先恢复文件映射
    if (fs.existsSync(bindFsPath)) {
      console.log(chalk.blue('正在恢复文件映射...'));
      const bindFiles = await fs.readdir(bindFsPath);
      for (const bindFile of bindFiles) {
        if (bindFile.endsWith('.metadata.json')) {
          const baseName = bindFile.replace('.metadata.json', '');
          const metadata = await fs.readJson(path.join(bindFsPath, bindFile));
          const bindTargetPath = metadata.hostPath;

          // 确保目标目录存在
          await fs.ensureDir(path.dirname(bindTargetPath));

          if (metadata.isFile) {
            // 如果是文件，直接复制
            await fs.copy(
              path.join(bindFsPath, baseName),
              bindTargetPath
            );
            // 恢复文件属性
            await fs.chmod(bindTargetPath, metadata.mode);
            await fs.chown(bindTargetPath, metadata.uid, metadata.gid);
            await fs.utimes(bindTargetPath, new Date(metadata.mtime), new Date(metadata.mtime));
            console.log(chalk.blue(`已恢复文件映射: ${bindTargetPath}`));
          } else if (metadata.isDirectory) {
            // 如果是目录，从 tar 文件恢复
            await tar.extract({
              file: path.join(bindFsPath, `${baseName}.tar`),
              cwd: path.dirname(bindTargetPath),
              preservePaths: true,
              preserveOwner: true,
              preserveMode: true,
              preserveTimestamps: true,
              strict: true
            });
            console.log(chalk.blue(`已恢复目录映射: ${bindTargetPath}`));
          }
        }
      }
    }

    // 创建新容器
    console.log(chalk.blue('正在创建容器...'));
    const container = await docker.createContainer(containerConfig);

    // 导入容器文件系统
    console.log(chalk.blue('正在导入容器文件系统...'));
    const tarStream = fs.createReadStream(tarPath);
    await container.putArchive(tarStream, {
      path: '/'
    });

    // 启动容器
    console.log(chalk.blue('正在启动容器...'));
    await container.start();

    console.log(chalk.green(`容器 ${containerInfo.Name} 已成功恢复并启动`));
  } catch (error) {
    console.error(chalk.red(`恢复失败: ${error.message}`));
  }
}

// 恢复镜像
async function restoreImages() {
  try {
    const imagesDir = path.join(BACKUP_DIR, 'images');
    if (!fs.existsSync(imagesDir)) {
      console.log(chalk.yellow('没有找到镜像备份'));
      return;
    }

    // 读取映射关系
    const mappingsPath = path.join(imagesDir, 'mappings.json');
    const imageMappings = fs.existsSync(mappingsPath) 
      ? await fs.readJson(mappingsPath)
      : {};

    const imageFiles = await fs.readdir(imagesDir);
    const jsonFiles = imageFiles.filter(file => file.endsWith('.json') && file !== 'mappings.json');

    console.log(chalk.blue(`找到 ${jsonFiles.length} 个镜像备份`));
    for (const jsonFile of jsonFiles) {
      const imageId = jsonFile.replace('.json', '');
      const imageConfig = await fs.readJson(path.join(imagesDir, jsonFile));
      const tarFile = `${imageId}.tar`;
      
      console.log(chalk.blue(`正在恢复镜像: ${imageId}`));

      const tarPath = path.join(imagesDir, tarFile);
      const imageStream = fs.createReadStream(tarPath);
      
      // 加载镜像
      await docker.loadImage(imageStream);
      
      // 如果有映射关系，设置标签
      if (imageMappings[imageId]) {
        const image = docker.getImage(imageId);
        for (const tag of imageMappings[imageId].repoTags) {
          const [repo, tagName] = tag.split(':');
          await image.tag({
            repo: repo,
            tag: tagName || 'latest'
          });
        }
        console.log(chalk.green(`镜像 ${imageId} 已恢复并设置标签: ${imageMappings[imageId].repoTags.join(', ')}`));
      } else {
        console.log(chalk.green(`镜像 ${imageId} 已恢复`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`恢复镜像失败: ${error.message}`));
    throw error;
  }
}

// 恢复网络
async function restoreNetworks() {
  try {
    const networksDir = path.join(BACKUP_DIR, 'networks');
    if (!fs.existsSync(networksDir)) {
      console.log(chalk.yellow('没有找到网络备份'));
      return;
    }

    const networkFiles = await fs.readdir(networksDir);
    console.log(chalk.blue(`找到 ${networkFiles.length} 个网络备份`));

    for (const networkFile of networkFiles) {
      const networkConfig = await fs.readJson(path.join(networksDir, networkFile));
      
      // 跳过默认网络
      if (networkConfig.Name === 'bridge' || 
          networkConfig.Name === 'host' || 
          networkConfig.Name === 'none' ||
          networkConfig.Name.startsWith('docker-') ||
          networkConfig.Name.startsWith('com.docker.')) {
        console.log(chalk.yellow(`跳过默认网络: ${networkConfig.Name}`));
        continue;
      }

      console.log(chalk.blue(`正在恢复网络: ${networkConfig.Name}`));

      try {
        await docker.createNetwork({
          Name: networkConfig.Name,
          Driver: networkConfig.Driver,
          Options: networkConfig.Options,
          Labels: networkConfig.Labels
        });
        console.log(chalk.green(`网络 ${networkConfig.Name} 已成功恢复`));
      } catch (error) {
        if (error.statusCode === 409) {
          console.log(chalk.yellow(`网络 ${networkConfig.Name} 已存在，跳过`));
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    console.error(chalk.red(`恢复网络失败: ${error.message}`));
    throw error;
  }
}

// 执行完整恢复
async function performFullRestore() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      throw new Error('备份目录不存在');
    }

    console.log(chalk.blue('开始完整恢复...'));

    // 确保 Alpine 镜像存在
    await ensureAlpineImage();

    // 先恢复镜像
    await restoreImages();

    // 恢复网络
    await restoreNetworks();

    // 恢复容器
    const containersDir = path.join(BACKUP_DIR, 'containers');
    if (fs.existsSync(containersDir)) {
      const containers = await fs.readdir(containersDir);
      const containerFiles = containers.filter(file => file.endsWith('.json'));
      for (const containerFile of containerFiles) {
        const containerId = containerFile.replace('.json', '');
        console.log(chalk.blue(`正在恢复容器: ${containerId}`));
        await restoreContainer(containerId);
      }
    }

    console.log(chalk.green(`完整恢复已完成`));
  } catch (error) {
    console.error(chalk.red(`完整恢复失败: ${error.message}`));
    throw error;
  }
}

// 列出所有备份
async function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      console.log(chalk.yellow('没有找到备份'));
      return;
    }

    console.log(chalk.blue('备份内容:'));

    // 显示备份时间
    const timestampPath = path.join(BACKUP_DIR, 'backup_timestamp.txt');
    if (fs.existsSync(timestampPath)) {
      const timestamp = await fs.readFile(timestampPath, 'utf8');
      console.log(chalk.green(`备份时间: ${timestamp.trim()}`));
    }

    // 显示备份内容统计
    const stats = {
      images: 0,
      containers: 0,
      networks: 0,
      volumes: 0
    };

    if (fs.existsSync(path.join(BACKUP_DIR, 'images'))) {
      stats.images = (await fs.readdir(path.join(BACKUP_DIR, 'images'))).length / 2;
    }
    if (fs.existsSync(path.join(BACKUP_DIR, 'containers'))) {
      stats.containers = (await fs.readdir(path.join(BACKUP_DIR, 'containers'))).length / 2;
    }
    if (fs.existsSync(path.join(BACKUP_DIR, 'networks'))) {
      stats.networks = (await fs.readdir(path.join(BACKUP_DIR, 'networks'))).length;
    }
    if (fs.existsSync(path.join(BACKUP_DIR, 'volumes'))) {
      stats.volumes = (await fs.readdir(path.join(BACKUP_DIR, 'volumes'))).length / 2;
    }

    console.log(`包含: ${stats.images} 个镜像, ${stats.containers} 个容器, ${stats.networks} 个网络, ${stats.volumes} 个卷`);
  } catch (error) {
    console.error(chalk.red(`列出备份失败: ${error.message}`));
    throw error;
  }
}

// 查找使用特定镜像的容器
async function findContainersByImage(imageId) {
  try {
    const containers = await docker.listContainers({ all: true });
    return containers.filter(container => container.ImageID === imageId);
  } catch (error) {
    console.error(chalk.red(`查找容器失败: ${error.message}`));
    throw error;
  }
}

// 通过名称查找镜像
async function findImageByName(imageName) {
  try {
    const images = await docker.listImages();
    // 尝试完全匹配
    let image = images.find(img => 
      img.RepoTags && img.RepoTags.includes(imageName)
    );
    
    // 如果没有完全匹配，尝试部分匹配
    if (!image) {
      image = images.find(img => 
        img.RepoTags && img.RepoTags.some(tag => tag.includes(imageName))
      );
    }
    
    return image;
  } catch (error) {
    console.error(chalk.red(`查找镜像失败: ${error.message}`));
    throw error;
  }
}

// 备份特定镜像及其容器
async function backupImageAndContainers(imageName) {
  try {
    console.log(chalk.blue(`开始查找镜像: ${imageName}`));
    
    // 通过名称查找镜像
    const targetImage = await findImageByName(imageName);
    
    if (!targetImage) {
      throw new Error(`未找到镜像: ${imageName}`);
    }

    console.log(chalk.blue(`找到镜像: ${targetImage.RepoTags.join(', ')}`));
    console.log(chalk.blue(`开始备份镜像 ${targetImage.Id} 及其相关容器...`));

    // 创建文件系统备份目录
    const fsBackupDir = path.join(BACKUP_DIR, 'fs');
    fs.ensureDirSync(path.join(fsBackupDir, 'volumes'));
    fs.ensureDirSync(path.join(fsBackupDir, 'binds'));

    // 使用现有的备份镜像函数
    await backupImages([targetImage]);

    // 查找并备份相关容器
    const relatedContainers = await findContainersByImage(targetImage.Id);
    console.log(chalk.blue(`找到 ${relatedContainers.length} 个使用该镜像的容器`));

    // 收集所有相关容器使用的网络
    const relatedNetworks = new Set();
    for (const container of relatedContainers) {
      const containerName = container.Names[0].replace('/', '');
      console.log(chalk.blue(`正在备份容器: ${containerName}`));
      await backupContainer(container.Id);
      
      // 获取容器详细信息以收集网络信息
      const containerInfo = await docker.getContainer(container.Id).inspect();
      if (containerInfo.NetworkSettings && containerInfo.NetworkSettings.Networks) {
        Object.keys(containerInfo.NetworkSettings.Networks).forEach(networkName => {
          // 跳过默认网络
          if (!['bridge', 'host', 'none'].includes(networkName) && 
              !networkName.startsWith('docker-') && 
              !networkName.startsWith('com.docker.')) {
            relatedNetworks.add(networkName);
          }
        });
      }
    }

    // 备份相关网络
    if (relatedNetworks.size > 0) {
      console.log(chalk.blue(`正在备份 ${relatedNetworks.size} 个相关网络...`));
      const networks = await docker.listNetworks();
      const networksToBackup = networks.filter(network => relatedNetworks.has(network.Name));
      await backupNetworks(networksToBackup);
    }

    // 备份 Docker 配置
    await backupConfig();

    // 验证备份
    await verifyBackup();

    console.log(chalk.green(`镜像 ${targetImage.RepoTags.join(', ')} 及其相关容器的备份已完成`));
  } catch (error) {
    console.error(chalk.red(`备份失败: ${error.message}`));
    throw error;
  }
}

// 解析 docker-compose 文件
async function parseComposeFile(composePath) {
  try {
    const composeDir = path.dirname(composePath);
    const envPath = path.join(composeDir, '.env');
    
    // 如果存在 .env 文件，加载环境变量
    if (fs.existsSync(envPath)) {
      const envConfig = dotenv.parse(fs.readFileSync(envPath));
      process.env = { ...process.env, ...envConfig };
    }

    // 读取 docker-compose.yml 文件
    const composeContent = fs.readFileSync(composePath, 'utf8');
    
    // 替换环境变量
    const processedContent = composeContent.replace(/\${([^}]+)}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });

    // 解析 YAML
    return yaml.load(processedContent);
  } catch (error) {
    console.error(chalk.red(`解析 docker-compose 文件失败: ${error.message}`));
    throw error;
  }
}

// 备份 docker-compose 项目
async function backupComposeProject(composePath) {
  try {
    console.log(chalk.blue('开始备份 docker-compose 项目...'));

    // 解析 docker-compose 文件
    const composeConfig = await parseComposeFile(composePath);
    const projectDir = path.dirname(composePath);
    const projectName = path.basename(projectDir);

    // 创建项目备份目录
    const projectBackupDir = path.join(BACKUP_DIR, 'compose', projectName);
    fs.ensureDirSync(projectBackupDir);

    // 备份 docker-compose.yml 和 .env 文件
    await fs.copy(composePath, path.join(projectBackupDir, 'docker-compose.yml'));
    const envPath = path.join(projectDir, '.env');
    if (fs.existsSync(envPath)) {
      await fs.copy(envPath, path.join(projectBackupDir, '.env'));
    }

    // 备份所有服务
    const services = composeConfig.services || {};
    for (const [serviceName, service] of Object.entries(services)) {
      console.log(chalk.blue(`正在备份服务: ${serviceName}`));

      // 备份镜像
      if (service.image) {
        const image = await findImageByName(service.image);
        if (image) {
          await backupImages([image]);
        }
      }

      // 备份卷
      if (service.volumes) {
        for (const volume of service.volumes) {
          if (typeof volume === 'string' && volume.includes(':')) {
            const [hostPath, containerPath] = volume.split(':');
            if (hostPath.startsWith('/')) {
              // 如果是绝对路径，备份文件映射
              const bindFsPath = path.join(projectBackupDir, 'binds', serviceName);
              fs.ensureDirSync(bindFsPath);
              await fs.copy(hostPath, path.join(bindFsPath, path.basename(hostPath)));
            }
          }
        }
      }
    }

    // 备份网络
    if (composeConfig.networks) {
      const networks = await docker.listNetworks();
      const projectNetworks = networks.filter(network => 
        network.Name.startsWith(`${projectName}_`)
      );
      await backupNetworks(projectNetworks);
    }

    console.log(chalk.green(`docker-compose 项目 ${projectName} 备份完成`));
  } catch (error) {
    console.error(chalk.red(`备份 docker-compose 项目失败: ${error.message}`));
    throw error;
  }
}

// 恢复 docker-compose 项目
async function restoreComposeProject(projectName) {
  try {
    console.log(chalk.blue(`开始恢复 docker-compose 项目: ${projectName}`));

    const projectBackupDir = path.join(BACKUP_DIR, 'compose', projectName);
    if (!fs.existsSync(projectBackupDir)) {
      throw new Error(`项目 ${projectName} 的备份不存在`);
    }

    // 恢复 docker-compose.yml 和 .env 文件
    const composePath = path.join(projectBackupDir, 'docker-compose.yml');
    const envPath = path.join(projectBackupDir, '.env');
    
    if (!fs.existsSync(composePath)) {
      throw new Error(`找不到 docker-compose.yml 文件`);
    }

    // 解析 docker-compose 文件
    const composeConfig = await parseComposeFile(composePath);

    // 恢复所有服务
    const services = composeConfig.services || {};
    for (const [serviceName, service] of Object.entries(services)) {
      console.log(chalk.blue(`正在恢复服务: ${serviceName}`));

      // 恢复镜像
      if (service.image) {
        await restoreImages();
      }

      // 恢复卷
      if (service.volumes) {
        for (const volume of service.volumes) {
          if (typeof volume === 'string' && volume.includes(':')) {
            const [hostPath, containerPath] = volume.split(':');
            if (hostPath.startsWith('/')) {
              // 如果是绝对路径，恢复文件映射
              const bindBackupPath = path.join(projectBackupDir, 'binds', serviceName, path.basename(hostPath));
              if (fs.existsSync(bindBackupPath)) {
                await fs.ensureDir(path.dirname(hostPath));
                await fs.copy(bindBackupPath, hostPath);
              }
            }
          }
        }
      }
    }

    // 恢复网络
    if (composeConfig.networks) {
      await restoreNetworks();
    }

    console.log(chalk.green(`docker-compose 项目 ${projectName} 恢复完成`));
  } catch (error) {
    console.error(chalk.red(`恢复 docker-compose 项目失败: ${error.message}`));
    throw error;
  }
}

// 命令行接口
program
  .version('1.0.0')
  .description('Docker 环境备份和恢复工具');

program
  .command('backup')
  .description('执行完整备份')
  .action(performFullBackup);

program
  .command('restore')
  .description('从备份恢复整个 Docker 环境')
  .action(performFullRestore);

program
  .command('list')
  .description('列出备份内容')
  .action(listBackups);

program
  .command('backup-image <imageName>')
  .description('备份特定镜像及其相关容器（支持镜像名称或标签，例如：nginx:latest）')
  .action(backupImageAndContainers);

program
  .command('backup-compose <composePath>')
  .description('备份 docker-compose 项目')
  .action(backupComposeProject);

program
  .command('restore-compose <projectName>')
  .description('恢复 docker-compose 项目')
  .action(restoreComposeProject);

program.parse(process.argv);
