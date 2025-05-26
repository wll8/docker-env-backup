#!/bin/bash

set -e

# 清理相关容器
docker ps -a --format '{{.Names}}' | grep -E '^test_web$|^test_web2$' | xargs -r docker rm -f

# 清理相关镜像
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep 'test_docker_env_test-web' | awk '{print $2}' | xargs -r docker rmi -f
docker images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | grep 'test_docker_env_test-web2' | awk '{print $2}' | xargs -r docker rmi -f

cd test_docker_env
docker-compose up -d --build

echo "测试环境已启动，访问：http://127.0.0.1:8080/api/config"

sleep 3

docker ps