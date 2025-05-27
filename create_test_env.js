#!/usr/bin/env node

const Docker = require('dockerode');
const path = require('path');
const { program } = require('commander');
const chalk = require('chalk');
const { execSync } = require('child_process');

const docker = new Docker();
const TEST_ENV_DIR = path.join(process.cwd(), 'test_docker_env');

// 清理测试环境
async function cleanupTestEnvironment() {
  try {
    console.log(chalk.blue('开始清理测试环境...'));

    // 清理相关容器
    console.log(chalk.blue('清理测试容器...'));
    const containers = await docker.listContainers({ all: true });
    for (const containerInfo of containers) {
      const name = containerInfo.Names[0].replace('/', '');
      if (name === 'test_web' || name === 'test_web2') {
        const container = docker.getContainer(containerInfo.Id);
        await container.stop();
        await container.remove();
        console.log(chalk.green(`容器 ${name} 已删除`));
      }
    }

    // 清理相关镜像
    console.log(chalk.blue('清理测试镜像...'));
    const images = await docker.listImages();
    for (const imageInfo of images) {
      const tags = imageInfo.RepoTags || [];
      if (tags.some(tag => tag.includes('test_docker_env_test-web'))) {
        await docker.getImage(imageInfo.Id).remove({ force: true });
        console.log(chalk.green(`镜像 ${tags[0]} 已删除`));
      }
    }

    console.log(chalk.green('测试环境清理完成'));
  } catch (error) {
    console.error(chalk.red(`清理测试环境失败: ${error.message}`));
    throw error;
  }
}

// 创建测试环境
async function createTestEnvironment() {
  try {
    console.log(chalk.blue('开始创建测试环境...'));

    // 先清理现有测试环境
    await cleanupTestEnvironment();

    // 确保在正确的目录
    process.chdir(TEST_ENV_DIR);

    // 使用 docker-compose 启动服务
    console.log(chalk.blue('启动 docker-compose 服务...'));
    execSync('docker-compose up -d --build', { stdio: 'inherit' });

    console.log(chalk.green('\n测试环境已启动，访问：http://127.0.0.1:8080/api/config'));

    // 等待服务启动
    console.log(chalk.blue('等待服务启动...'));
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 显示运行中的容器
    console.log(chalk.blue('\n运行中的容器：'));
    const containers = await docker.listContainers();
    
    // 准备表格数据
    const tableData = containers.map(containerInfo => {
      const name = containerInfo.Names[0].replace('/', '');
      const image = containerInfo.Image;
      const status = containerInfo.Status;
      
      // 处理端口映射
      const ports = containerInfo.Ports
        .filter(p => p.PublicPort && p.PrivatePort)
        .map(p => `${p.PublicPort}:${p.PrivatePort}`)
        .filter((port, index, self) => self.indexOf(port) === index)
        .join(', ');

      return {
        '容器名称': name,
        '镜像': image,
        '状态': status,
        '端口映射': ports
      };
    });

    // 使用 console.table 显示
    console.table(tableData);

  } catch (error) {
    console.error(chalk.red(`创建测试环境失败: ${error.message}`));
    throw error;
  }
}

// 命令行接口
program
  .version('1.0.0')
  .description('Docker 测试环境创建工具')
  .action(createTestEnvironment);

program.parse(process.argv); 