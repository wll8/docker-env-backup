#!/usr/bin/env node

const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');
const tar = require('tar');
const { program } = require('commander');
const chalk = require('chalk');
const crypto = require('crypto');

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
async function backupNetworks() {
  try {
    const networks = await docker.listNetworks();
    const networksDir = path.join(BACKUP_DIR, 'networks');
    fs.ensureDirSync(networksDir);

    console.log(chalk.blue(`找到 ${networks.length} 个网络`));
    for (const network of networks) {
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

// 备份卷
async function backupVolume(volumeName) {
  try {
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
    const volumeTarPath = path.join(BACKUP_DIR, 'volumes', `${volumeInfo.Name}.tar`);
    const writeStream = fs.createWriteStream(volumeTarPath);

    await new Promise((resolve, reject) => {
      tarStream.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // 保存卷配置
    const volumeConfigPath = path.join(BACKUP_DIR, 'volumes', `${volumeInfo.Name}.json`);
    await fs.writeJson(volumeConfigPath, volumeInfo, { spaces: 2 });

    // 创建卷内容的文件系统备份
    const volumeFsPath = path.join(BACKUP_DIR, 'fs', 'volumes', volumeInfo.Name);
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

      for (const bind of binds) {
        const [hostPath, containerPath] = bind.split(':');
        if (fs.existsSync(hostPath)) {
          const bindBackupPath = path.join(bindFsPath, path.basename(hostPath));
          
          // 使用 tar 备份文件映射，保持所有属性
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
          
          console.log(chalk.blue(`已备份文件映射: ${hostPath} -> ${containerPath}`));
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
      await existingContainer.stop();
      await existingContainer.remove();
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

    // 创建新容器
    console.log(chalk.blue('正在创建容器...'));
    const container = await docker.createContainer(containerConfig);

    // 导入容器文件系统
    console.log(chalk.blue('正在导入容器文件系统...'));
    const tarStream = fs.createReadStream(tarPath);
    await container.putArchive(tarStream, {
      path: '/'
    });

    // 恢复文件映射
    if (fs.existsSync(bindFsPath)) {
      console.log(chalk.blue('正在恢复文件映射...'));
      const bindFiles = await fs.readdir(bindFsPath);
      for (const bindFile of bindFiles) {
        if (bindFile.endsWith('.tar')) {
          const bindSourcePath = path.join(bindFsPath, bindFile);
          const bindTargetPath = containerInfo.HostConfig.Binds
            .find(bind => bind.split(':')[0].endsWith(bindFile.replace('.tar', '')))
            ?.split(':')[0];

          if (bindTargetPath) {
            // 从 tar 文件恢复，保持所有属性
            await tar.extract({
              file: bindSourcePath,
              cwd: path.dirname(bindTargetPath),
              preservePaths: true,
              preserveOwner: true,
              preserveMode: true,
              preserveTimestamps: true,
              strict: true
            });
            console.log(chalk.blue(`已恢复文件映射: ${bindSourcePath} -> ${bindTargetPath}`));
          }
        }
      }
    }

    // 启动容器
    console.log(chalk.blue('正在启动容器...'));
    await container.start();

    console.log(chalk.green(`容器 ${containerInfo.Name} 已成功恢复并启动`));
  } catch (error) {
    console.error(chalk.red(`恢复失败: ${error.message}`));
    throw error;
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

    for (const container of relatedContainers) {
      const containerName = container.Names[0].replace('/', '');
      console.log(chalk.blue(`正在备份容器: ${containerName}`));
      await backupContainer(container.Id);
    }

    // 验证备份
    await verifyBackup();

    console.log(chalk.green(`镜像 ${targetImage.RepoTags.join(', ')} 及其相关容器的备份已完成`));
  } catch (error) {
    console.error(chalk.red(`备份失败: ${error.message}`));
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

program.parse(process.argv);
