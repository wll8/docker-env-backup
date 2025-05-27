#!/usr/bin/env node

const Docker = require('dockerode');
const chalk = require('chalk');
const { program } = require('commander');

const docker = new Docker();

// 清理所有容器
async function cleanupContainers() {
  try {
    console.log(chalk.blue('正在清理所有容器...'));
    const containers = await docker.listContainers({ all: true });
    
    for (const containerInfo of containers) {
      const container = docker.getContainer(containerInfo.Id);
      const name = containerInfo.Names[0].replace('/', '');
      
      try {
        if (containerInfo.State === 'running') {
          await container.stop();
          console.log(chalk.yellow(`停止容器: ${name}`));
        }
        await container.remove();
        console.log(chalk.green(`删除容器: ${name}`));
      } catch (error) {
        console.error(chalk.red(`清理容器 ${name} 失败: ${error.message}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`获取容器列表失败: ${error.message}`));
  }
}

// 清理所有镜像
async function cleanupImages() {
  try {
    console.log(chalk.blue('正在清理所有镜像...'));
    const images = await docker.listImages();
    
    for (const imageInfo of images) {
      try {
        const image = docker.getImage(imageInfo.Id);
        const tags = imageInfo.RepoTags || [];
        await image.remove({ force: true });
        console.log(chalk.green(`删除镜像: ${tags.join(', ') || imageInfo.Id}`));
      } catch (error) {
        console.error(chalk.red(`清理镜像失败: ${error.message}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`获取镜像列表失败: ${error.message}`));
  }
}

// 清理所有网络
async function cleanupNetworks() {
  try {
    console.log(chalk.blue('正在清理所有网络...'));
    const networks = await docker.listNetworks();
    
    for (const networkInfo of networks) {
      // 跳过默认网络
      if (['bridge', 'host', 'none'].includes(networkInfo.Name)) {
        continue;
      }
      
      try {
        const network = docker.getNetwork(networkInfo.Id);
        await network.remove();
        console.log(chalk.green(`删除网络: ${networkInfo.Name}`));
      } catch (error) {
        console.error(chalk.red(`清理网络 ${networkInfo.Name} 失败: ${error.message}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`获取网络列表失败: ${error.message}`));
  }
}

// 清理所有卷
async function cleanupVolumes() {
  try {
    console.log(chalk.blue('正在清理所有卷...'));
    const volumes = await docker.listVolumes();
    
    for (const volumeInfo of volumes.Volumes) {
      try {
        const volume = docker.getVolume(volumeInfo.Name);
        await volume.remove();
        console.log(chalk.green(`删除卷: ${volumeInfo.Name}`));
      } catch (error) {
        console.error(chalk.red(`清理卷 ${volumeInfo.Name} 失败: ${error.message}`));
      }
    }
  } catch (error) {
    console.error(chalk.red(`获取卷列表失败: ${error.message}`));
  }
}

// 执行完整清理
async function performFullCleanup() {
  try {
    console.log(chalk.blue('开始清理 Docker 环境...'));
    
    // 按顺序执行清理
    await cleanupContainers();
    await cleanupImages();
    await cleanupNetworks();
    await cleanupVolumes();
    
    console.log(chalk.green('\nDocker 环境清理完成！'));
  } catch (error) {
    console.error(chalk.red(`清理过程出错: ${error.message}`));
    process.exit(1);
  }
}

// 命令行接口
program
  .version('1.0.0')
  .description('Docker 环境清理工具')
  .action(performFullCleanup);

program.parse(process.argv); 