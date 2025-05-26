#!/bin/bash

# 检查是否以root权限运行
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}错误: 请使用 sudo 运行此脚本${NC}"
    echo "使用方法: sudo $0 [选项] <备份目录路径>"
    exit 1
fi

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 确认函数
confirm() {
    printf "\n"
    read -p "$1 (y/n) " -n 1 -r
    printf "\n"
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1
    fi
    return 0
}

# 备份前检查
pre_backup_check() {
    # 检查 Docker 服务状态
    if ! systemctl is-active --quiet docker; then
        echo -e "${RED}错误: Docker 服务未运行${NC}"
        return 1
    fi
    
    # 检查磁盘空间
    local required_space=$(du -s /var/lib/docker | awk '{print $1}')
    local available_space=$(df -k "$BACKUP_DIR" | awk 'NR==2 {print $4}')
    if [ $available_space -lt $required_space ]; then
        echo -e "${RED}错误: 备份目录空间不足${NC}"
        return 1
    fi
    
    # 检查备份目录权限
    if [ ! -w "$BACKUP_DIR" ]; then
        echo -e "${RED}错误: 备份目录没有写入权限${NC}"
        return 1
    fi
    
    return 0
}

# 备份后验证
post_backup_verify() {
    local backup_dir="$1"
    
    # 验证备份文件完整性
    if [ -f "$backup_dir/checksums.txt" ]; then
        echo "验证备份文件完整性..."
        # 切换到备份目录
        pushd "$backup_dir" > /dev/null
        
        # 重新生成校验和
        find . -type f -not -path "./checksums.txt" -not -path "./checksums.txt.new" -exec sha256sum {} \; > checksums.txt.new
        
        # 比较新旧校验和
        if diff -q checksums.txt checksums.txt.new > /dev/null; then
            echo -e "${GREEN}备份文件完整性验证通过${NC}"
            rm checksums.txt.new
        else
            echo -e "${RED}错误: 备份文件完整性验证失败${NC}"
            echo "差异文件列表:"
            diff checksums.txt checksums.txt.new | grep -v "^[0-9]" | grep -v "^---" | grep -v "^+++"
            rm checksums.txt.new
            popd > /dev/null
            return 1
        fi
        
        popd > /dev/null
    else
        echo -e "${YELLOW}警告: 未找到校验和文件，正在生成...${NC}"
        verify_backup "$backup_dir"
    fi
    
    # 验证备份目录结构
    local required_dirs=("images" "containers" "volumes" "networks" "config")
    for dir in "${required_dirs[@]}"; do
        if [ ! -d "$backup_dir/$dir" ]; then
            echo -e "${RED}错误: 缺少必要的备份目录: $dir${NC}"
            return 1
        fi
    done
    
    return 0
}

# 验证备份
verify_backup() {
    local backup_dir="$1"
    
    # 确保在备份目录中
    pushd "$backup_dir" > /dev/null
    
    # 记录备份时的 Docker 环境信息
    docker info > docker_info.txt
    docker version > docker_version.txt
    
    # 记录备份时间戳
    echo "备份时间: $(date)" > backup_timestamp.txt
    
    # 记录所有备份项的校验和（排除校验和文件本身）
    find . -type f -not -path "./checksums.txt" -not -path "./checksums.txt.new" -exec sha256sum {} \; > checksums.txt
    
    # 返回原目录
    popd > /dev/null
}

# 显示菜单
show_menu() {
    clear
    echo -e "${GREEN}Docker 备份工具${NC}"
    printf "\n%s\n" "===================================================="
    echo "1. 显示当前 Docker 状态"
    echo "2. 停止所有容器"
    echo "3. 备份 Docker 镜像"
    echo "4. 备份容器配置"
    echo "5. 备份 Docker 卷"
    echo "6. 备份网络配置"
    echo "7. 备份 Docker 配置文件"
    echo "8. 执行完整备份流程"
    echo "88. 执行完整备份流程（无需确认）"
    echo "9. 恢复容器状态"
    echo "99. 恢复容器状态（无需确认）"
    echo "0. 退出"
    printf "\n%s\n" "===================================================="
    printf "\n%s" "请选择操作 (0-99): "
}

# 显示 Docker 状态
show_docker_status() {
    printf "\n"
    echo -e "${YELLOW}当前 Docker 状态:${NC}"
    printf "\n"
    echo "运行中的容器:"
    docker ps
    printf "\n"
    echo "所有容器:"
    docker ps -a
    printf "\n"
    echo "Docker 镜像:"
    docker images
    printf "\n"
    echo "Docker 卷:"
    docker volume ls
    printf "\n"
    echo "Docker 网络:"
    docker network ls
    printf "\n"
}

# 停止所有容器
stop_containers() {
    RUNNING_CONTAINERS=$(docker ps -q)
    if [ ! -z "$RUNNING_CONTAINERS" ]; then
        echo -e "\n${YELLOW}发现运行中的容器:${NC}"
        docker ps
        if confirm "是否停止所有容器？"; then
            echo "正在停止容器..."
            docker stop $RUNNING_CONTAINERS
            echo -e "${GREEN}所有容器已停止${NC}"
        fi
    else
        echo -e "${GREEN}没有运行中的容器${NC}"
    fi
}

# 计算文件 SHA256
calculate_sha256() {
    sha256sum "$1" | awk '{print $1}'
}

# 检查并拉取 Alpine 镜像
ensure_alpine_image() {
    echo "检查 Alpine 镜像..."
    if ! docker image inspect alpine:latest >/dev/null 2>&1; then
        echo "正在拉取 Alpine 镜像..."
        if ! docker pull alpine:latest; then
            echo -e "${RED}拉取 Alpine 镜像失败${NC}"
            return 1
        fi
    fi
    echo -e "${GREEN}Alpine 镜像就绪${NC}"
    return 0
}

# 备份 Docker 镜像
backup_images() {
    # 获取所有镜像
    local images=($(docker images --format "{{.Repository}}:{{.Tag}}"))
    if [ ${#images[@]} -eq 0 ]; then
        echo -e "\n${YELLOW}没有找到任何 Docker 镜像${NC}"
        return 1
    fi

    # 显示镜像列表
    echo -e "\n${YELLOW}当前 Docker 镜像列表:${NC}"
    printf "\n%s\n" "===================================================="
    echo -e "${GREEN}编号\t镜像名称\t\t\t\t大小${NC}"
    printf "\n%s\n" "----------------------------------------------------"
    echo -e "0\t[全选]"
    printf "\n%s\n" "----------------------------------------------------"
    
    # 显示镜像列表
    local i=1
    for image in "${images[@]}"; do
        size=$(docker images "$image" --format "{{.Size}}")
        echo -e "$i\t$image\t$size"
        i=$((i+1))
    done
    printf "\n%s\n" "===================================================="
    
    # 获取用户选择
    read -p "请选择要备份的镜像编号（多个编号用空格分隔，输入 0 选择所有镜像）: " choices
    
    # 处理选择
    local selected=()
    if [[ "$choices" == "0" ]]; then
        selected=("${images[@]}")
    else
        for choice in $choices; do
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -le "${#images[@]}" ]; then
                selected+=("${images[$((choice-1))]}")
            else
                echo -e "${RED}无效的选择: $choice${NC}"
            fi
        done
    fi
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何镜像${NC}"
        return 1
    fi
    
    # 显示已选择的镜像
    echo -e "\n${GREEN}已选择的镜像:${NC}"
    printf "\n%s\n" "===================================================="
    for img in "${selected[@]}"; do
        size=$(docker images "$img" --format "{{.Size}}")
        echo -e "$img\t$size"
    done
    printf "\n%s\n" "===================================================="
    
    # 确认备份
    printf "\n"
    if ! confirm "确认备份以上镜像？"; then
        return 1
    fi
    
    # 开始备份
    printf "\n"
    echo "正在备份选中的镜像..."
    
    # 创建 SHA256 记录文件
    SHA_FILE="$BACKUP_DIR/images/sha256.txt"
    touch "$SHA_FILE"
    
    # 备份选中的镜像
    for image in "${selected[@]}"; do
        if [ ! -z "$image" ]; then
            backup_file="$BACKUP_DIR/images/$(echo $image | tr '/' '_' | tr ':' '_').tar.gz"
            
            # 检查文件是否已存在且未更改
            if [ -f "$backup_file" ]; then
                old_sha=$(grep "$backup_file" "$SHA_FILE" | awk '{print $1}')
                if [ ! -z "$old_sha" ]; then
                    current_sha=$(calculate_sha256 "$backup_file")
                    if [ "$old_sha" == "$current_sha" ]; then
                        echo -e "${YELLOW}跳过未更改的镜像: $image${NC}"
                        continue
                    fi
                fi
            fi
            
            echo "保存镜像: $image"
            if docker save "$image" | gzip > "$backup_file"; then
                # 更新 SHA256 记录
                new_sha=$(calculate_sha256 "$backup_file")
                # 使用临时文件更新 SHA256 记录
                grep -v "$backup_file" "$SHA_FILE" > "${SHA_FILE}.tmp"
                echo "$new_sha $backup_file" >> "${SHA_FILE}.tmp"
                mv "${SHA_FILE}.tmp" "$SHA_FILE"
                echo -e "${GREEN}成功备份镜像: $image${NC}"
            else
                echo -e "${RED}备份镜像失败: $image${NC}"
            fi
        fi
    done
    echo -e "${GREEN}镜像备份完成${NC}"
}

# 备份容器配置
backup_containers() {
    if confirm "是否备份所有容器配置？"; then
        echo "正在备份容器配置..."
        docker ps -a --format "{{.Names}}" | while read container; do
            if [ ! -z "$container" ]; then
                echo "备份容器配置: $container"
                # 备份完整的容器配置
                docker container inspect "$container" > "$BACKUP_DIR/containers/$container.json"
                # 备份容器日志
                docker logs "$container" > "$BACKUP_DIR/containers/$container.log" 2>&1
                # 备份容器元数据
                docker container inspect "$container" > "$BACKUP_DIR/containers/$container.metadata.json"
            fi
        done
        echo -e "${GREEN}容器配置备份完成${NC}"
    fi
}

# 创建卷名映射文件
create_volume_map() {
    local map_file="$BACKUP_DIR/volumes/volume_map.txt"
    echo "# 卷名映射文件 - 格式: 原始卷名=备份文件名" > "$map_file"
    echo "# 生成时间: $(date)" >> "$map_file"
    echo "" >> "$map_file"
}

# 获取安全的卷名
get_safe_volume_name() {
    local volume_name="$1"
    # 将卷名转换为小写
    local safe_name=$(echo "$volume_name" | tr '[:upper:]' '[:lower:]')
    # 替换非法字符为下划线
    safe_name=$(echo "$safe_name" | sed 's/[^a-z0-9_.-]/_/g')
    # 确保以字母或数字开头
    if [[ ! "$safe_name" =~ ^[a-z0-9] ]]; then
        safe_name="vol_${safe_name}"
    fi
    echo "$safe_name"
}

# 备份 Docker 卷
backup_volumes() {
    if confirm "是否备份所有 Docker 卷？"; then
        echo "正在备份 Docker 卷..."
        
        # 创建卷备份目录
        mkdir -p "$BACKUP_DIR/volumes"
        
        # 创建卷名映射文件
        create_volume_map
        local map_file="$BACKUP_DIR/volumes/volume_map.txt"
        
        # 获取所有卷
        docker volume ls --format "{{.Name}}" | while read volume; do
            if [ ! -z "$volume" ]; then
                # 生成安全的卷名
                safe_name=$(get_safe_volume_name "$volume")
                
                # 记录卷名映射
                echo "$volume=$safe_name" >> "$map_file"
                
                echo "备份卷: $volume (映射为: $safe_name)"
                
                # 获取卷的挂载点
                volume_path=$(docker volume inspect -f '{{.Mountpoint}}' "$volume")
                if [ -z "$volume_path" ]; then
                    echo -e "${RED}无法获取卷挂载点: $volume${NC}"
                    continue
                fi
                
                # 直接使用 tar 命令备份
                if tar -czf "$BACKUP_DIR/volumes/$safe_name.tar.gz" -C "$volume_path" .; then
                    # 备份卷元数据
                    docker volume inspect "$volume" > "$BACKUP_DIR/volumes/$safe_name.metadata.json"
                    echo -e "${GREEN}成功备份卷: $volume${NC}"
                else
                    echo -e "${RED}备份卷失败: $volume${NC}"
                    continue
                fi
            fi
        done
        echo -e "${GREEN}卷备份完成${NC}"
    fi
}

# 备份网络配置
backup_networks() {
    if confirm "是否备份所有网络配置？"; then
        echo "正在备份网络配置..."
        docker network ls --format "{{.Name}}" | while read network; do
            # 跳过系统默认网络
            if [[ "$network" =~ ^(bridge|host|none)$ ]]; then
                echo "跳过系统默认网络: $network"
                continue
            fi
            
            if [ ! -z "$network" ]; then
                echo "备份网络配置: $network"
                # 备份完整网络配置
                docker network inspect "$network" > "$BACKUP_DIR/networks/$network.json"
                # 备份网络连接信息
                docker network inspect "$network" -f '{{range .Containers}}{{.Name}} {{end}}' > "$BACKUP_DIR/networks/$network.connections.txt"
            fi
        done
        echo -e "${GREEN}网络配置备份完成${NC}"
    fi
}

# 备份 Docker 配置文件
backup_config() {
    if confirm "是否备份 Docker 配置文件？"; then
        echo "正在备份 Docker 配置文件..."
        cp /etc/docker/daemon.json "$BACKUP_DIR/config/" 2>/dev/null || true
        echo -e "${GREEN}配置文件备份完成${NC}"
    fi
}

# 执行完整备份流程
full_backup() {
    # 备份前检查
    if ! pre_backup_check; then
        return 1
    fi
    
    # 停止所有容器
    if ! stop_containers; then
        return 1
    fi
    
    # 备份各个组件
    backup_images
    backup_containers
    backup_volumes
    backup_networks
    backup_config
    
    # 备份后验证
    if ! post_backup_verify "$BACKUP_DIR"; then
        echo -e "${RED}备份验证失败${NC}"
        return 1
    fi
    
    # 记录备份信息
    verify_backup "$BACKUP_DIR"
    
    echo -e "${GREEN}完整备份流程完成${NC}"
}

# 执行完整备份流程（无需确认）
full_backup_no_confirm() {
    # 备份前检查
    if ! pre_backup_check; then
        return 1
    fi
    
    # 停止所有容器
    echo "正在停止所有容器..."
    docker stop $(docker ps -q) 2>/dev/null || true
    
    # 备份所有镜像
    echo "正在备份所有镜像..."
    docker images --format "{{.Repository}}:{{.Tag}}" | while read image; do
        if [ ! -z "$image" ]; then
            backup_file="$BACKUP_DIR/images/$(echo $image | tr '/' '_' | tr ':' '_').tar.gz"
            echo "保存镜像: $image"
            docker save "$image" | gzip > "$backup_file" || echo -e "${RED}备份镜像失败: $image${NC}"
        fi
    done
    
    # 备份所有容器配置
    echo "正在备份所有容器配置..."
    docker ps -a --format "{{.Names}}" | while read container; do
        if [ ! -z "$container" ]; then
            echo "备份容器配置: $container"
            docker inspect "$container" > "$BACKUP_DIR/containers/$container.json"
            docker logs "$container" > "$BACKUP_DIR/containers/$container.log" 2>&1
            docker container inspect "$container" > "$BACKUP_DIR/containers/$container.metadata.json"
        fi
    done
    
    # 备份所有卷
    echo "正在备份所有卷..."
    # 创建卷名映射文件
    create_volume_map
    local map_file="$BACKUP_DIR/volumes/volume_map.txt"
    
    docker volume ls --format "{{.Name}}" | while read volume; do
        if [ ! -z "$volume" ]; then
            # 生成安全的卷名
            safe_name=$(get_safe_volume_name "$volume")
            
            # 记录卷名映射
            echo "$volume=$safe_name" >> "$map_file"
            
            echo "备份卷: $volume (映射为: $safe_name)"
            
            # 获取卷的挂载点
            volume_path=$(docker volume inspect -f '{{.Mountpoint}}' "$volume")
            if [ -z "$volume_path" ]; then
                echo -e "${RED}无法获取卷挂载点: $volume${NC}"
                continue
            fi
            
            # 直接使用 tar 命令备份
            if tar -czf "$BACKUP_DIR/volumes/$safe_name.tar.gz" -C "$volume_path" .; then
                # 备份卷元数据
                docker volume inspect "$volume" > "$BACKUP_DIR/volumes/$safe_name.metadata.json"
                echo -e "${GREEN}成功备份卷: $volume${NC}"
            else
                echo -e "${RED}备份卷失败: $volume${NC}"
                continue
            fi
        fi
    done
    
    # 备份所有网络配置
    echo "正在备份所有网络配置..."
    docker network ls --format "{{.Name}}" | while read network; do
        # 跳过系统默认网络
        if [[ "$network" =~ ^(bridge|host|none)$ ]]; then
            echo "跳过系统默认网络: $network"
            continue
        fi
        
        if [ ! -z "$network" ]; then
            echo "备份网络配置: $network"
            docker network inspect "$network" > "$BACKUP_DIR/networks/$network.json"
            docker network inspect "$network" -f '{{range .Containers}}{{.Name}} {{end}}' > "$BACKUP_DIR/networks/$network.connections.txt"
        fi
    done
    
    # 备份 Docker 配置文件
    echo "正在备份 Docker 配置文件..."
    if [ -f "/etc/docker/daemon.json" ]; then
        cp /etc/docker/daemon.json "$BACKUP_DIR/config/" 2>/dev/null || true
    else
        echo "未找到 Docker 配置文件"
    fi
    
    # 备份后验证
    if ! post_backup_verify "$BACKUP_DIR"; then
        echo -e "${RED}备份验证失败${NC}"
        return 1
    fi
    
    # 记录备份信息
    verify_backup "$BACKUP_DIR"
    
    echo -e "${GREEN}完整备份流程完成${NC}"
}

# 检查依赖
check_dependencies() {
    local missing_deps=()
    
    # 检查 jq
    if ! command -v jq >/dev/null 2>&1; then
        missing_deps+=("jq")
    fi
    
    # 检查 docker
    if ! command -v docker >/dev/null 2>&1; then
        missing_deps+=("docker")
    fi
    
    # 检查 sha256sum
    if ! command -v sha256sum >/dev/null 2>&1; then
        missing_deps+=("coreutils")
    fi
    
    # 如果有缺失的依赖
    if [ ${#missing_deps[@]} -gt 0 ]; then
        echo -e "${RED}错误: 缺少必要的依赖${NC}"
        echo "请安装以下软件包:"
        for dep in "${missing_deps[@]}"; do
            echo "- $dep"
        done
        echo -e "\n在 Ubuntu 上可以使用以下命令安装:"
        echo "sudo apt-get update"
        echo "sudo apt-get install -y ${missing_deps[*]}"
        return 1
    fi
    
    return 0
}

# 恢复 Docker 镜像
restore_images() {
    local backup_dir="$1"
    local images_dir="$backup_dir/images"
    
    # 检查依赖
    if ! check_dependencies; then
        return 1
    fi
    
    if [ ! -d "$images_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到镜像目录${NC}"
        return 1
    fi
    
    # 获取所有备份的镜像文件
    local image_files=($(ls "$images_dir"/*.tar.gz 2>/dev/null))
    if [ ${#image_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的镜像${NC}"
        return 1
    fi
    
    # 显示可恢复的镜像列表
    echo -e "\n${YELLOW}可恢复的镜像列表:${NC}"
    printf "\n%s\n" "===================================================="
    echo -e "${GREEN}编号\t镜像文件${NC}"
    printf "%s\n" "----------------------------------------------------"
    echo -e "0\t[全选]"
    printf "%s\n" "----------------------------------------------------"
    
    local i=1
    for img_file in "${image_files[@]}"; do
        echo -e "$i\t$(basename "$img_file")"
        i=$((i+1))
    done
    printf "\n%s\n" "===================================================="
    
    # 获取用户选择
    read -p "请选择要恢复的镜像编号（多个编号用空格分隔，输入 0 选择所有镜像）: " choices
    
    # 处理选择
    local selected=()
    if [[ "$choices" == "0" ]]; then
        selected=("${image_files[@]}")
    else
        for choice in $choices; do
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -le "${#image_files[@]}" ]; then
                selected+=("${image_files[$((choice-1))]}")
            else
                echo -e "${RED}无效的选择: $choice${NC}"
            fi
        done
    fi
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何镜像${NC}"
        return 1
    fi
    
    # 显示已选择的镜像
    echo -e "\n${GREEN}已选择的镜像:${NC}"
    printf "\n%s\n" "===================================================="
    for img_file in "${selected[@]}"; do
        echo -e "$(basename "$img_file")"
    done
    printf "\n%s\n" "===================================================="
    
    # 确认恢复
    if ! confirm "确认恢复以上镜像？"; then
        return 1
    fi
    
    # 开始恢复
    echo "正在恢复选中的镜像..."
    for img_file in "${selected[@]}"; do
        echo "恢复镜像: $(basename "$img_file")"
        if gunzip -c "$img_file" | docker load; then
            echo -e "${GREEN}成功恢复镜像: $(basename "$img_file")${NC}"
        else
            echo -e "${RED}恢复镜像失败: $(basename "$img_file")${NC}"
        fi
    done
    echo -e "${GREEN}镜像恢复完成${NC}"
}

# 恢复容器配置
restore_containers() {
    local backup_dir="$1"
    local containers_dir="$backup_dir/containers"
    
    # 检查依赖
    if ! check_dependencies; then
        return 1
    fi
    
    if [ ! -d "$containers_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到容器配置目录${NC}"
        return 1
    fi
    
    # 获取所有备份的容器配置文件
    local container_files=($(ls "$containers_dir"/*.json 2>/dev/null))
    if [ ${#container_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的容器配置${NC}"
        return 1
    fi
    
    # 显示可恢复的容器列表
    echo -e "\n${YELLOW}可恢复的容器配置列表:${NC}"
    printf "\n%s\n" "===================================================="
    echo -e "${GREEN}编号\t容器配置${NC}"
    printf "%s\n" "----------------------------------------------------"
    echo -e "0\t[全选]"
    printf "%s\n" "----------------------------------------------------"
    
    local i=1
    for container_file in "${container_files[@]}"; do
        echo -e "$i\t$(basename "$container_file")"
        i=$((i+1))
    done
    printf "\n%s\n" "===================================================="
    
    # 获取用户选择
    read -p "请选择要恢复的容器配置编号（多个编号用空格分隔，输入 0 选择所有配置）: " choices
    
    # 处理选择
    local selected=()
    if [[ "$choices" == "0" ]]; then
        selected=("${container_files[@]}")
    else
        for choice in $choices; do
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -le "${#container_files[@]}" ]; then
                selected+=("${container_files[$((choice-1))]}")
            else
                echo -e "${RED}无效的选择: $choice${NC}"
            fi
        done
    fi
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何容器配置${NC}"
        return 1
    fi
    
    # 显示已选择的容器配置
    echo -e "\n${GREEN}已选择的容器配置:${NC}"
    printf "\n%s\n" "===================================================="
    for container_file in "${selected[@]}"; do
        echo -e "$(basename "$container_file")"
    done
    printf "\n%s\n" "===================================================="
    
    # 确认恢复
    printf "\n"
    if ! confirm "确认恢复以上容器配置？"; then
        return 1
    fi
    
    # 开始恢复
    printf "\n"
    echo "正在恢复选中的容器配置..."
    for container_file in "${selected[@]}"; do
        container_name=$(basename "$container_file" .json)
        echo "恢复容器配置: $container_name"
        
        # 检查容器是否已存在
        if docker ps -a --format "{{.Names}}" | grep -q "^${container_name}$"; then
            echo -e "${YELLOW}容器 $container_name 已存在${NC}"
            if ! confirm "是否删除已存在的容器？"; then
                echo -e "${YELLOW}跳过容器: $container_name${NC}"
                continue
            fi
            echo "删除已存在的容器: $container_name"
            docker rm -f "$container_name" || {
                echo -e "${RED}删除容器失败: $container_name${NC}"
                continue
            }
        fi
        
        # 读取容器配置
        config=$(cat "$container_file")
        
        # 提取必要信息
        image=$(echo "$config" | jq -r '.[0].Config.Image')
        if [ -z "$image" ] || [ "$image" == "null" ]; then
            echo -e "${RED}错误: 无法从配置中提取镜像信息${NC}"
            continue
        fi
        
        # 检查镜像是否存在
        if ! docker image inspect "$image" >/dev/null 2>&1; then
            echo -e "${RED}错误: 镜像 $image 不存在${NC}"
            if ! confirm "是否尝试拉取镜像？"; then
                echo -e "${YELLOW}跳过容器: $container_name${NC}"
                continue
            fi
            echo "正在拉取镜像: $image"
            if ! docker pull "$image"; then
                echo -e "${RED}拉取镜像失败: $image${NC}"
                continue
            fi
        fi
        
        # 构建运行命令
        run_cmd="docker run -d --name $container_name"
        
        # 添加环境变量
        env=$(echo "$config" | jq -r '.[0].Config.Env[]' 2>/dev/null)
        if [ ! -z "$env" ] && [ "$env" != "null" ]; then
            for e in $env; do
                run_cmd="$run_cmd -e \"$e\""
            done
        fi
        
        # 添加端口映射
        # 从 HostConfig.PortBindings 中提取端口映射
        port_bindings=$(echo "$config" | jq -r '.[0].HostConfig.PortBindings | to_entries[] | .key + ":" + .value[0].HostPort' 2>/dev/null)
        if [ ! -z "$port_bindings" ] && [ "$port_bindings" != "null" ]; then
            for p in $port_bindings; do
                run_cmd="$run_cmd -p $p"
            done
        fi
        
        # 添加卷挂载
        volumes=$(echo "$config" | jq -r '.[0].Mounts[] | .Source + ":" + .Destination' 2>/dev/null)
        if [ ! -z "$volumes" ] && [ "$volumes" != "null" ]; then
            for v in $volumes; do
                source_path=$(echo "$v" | cut -d':' -f1)
                if [ ! -e "$source_path" ]; then
                    echo "创建路径: $source_path"
                    if [[ "$source_path" == *.* ]]; then
                        mkdir -p "$(dirname "$source_path")"
                        touch "$source_path"
                    else
                        mkdir -p "$source_path"
                    fi
                fi
                run_cmd="$run_cmd -v $v"
            done
        fi
        
        # 添加网络配置
        networks=$(echo "$config" | jq -r '.[0].NetworkSettings.Networks | keys[]' 2>/dev/null)
        if [ ! -z "$networks" ] && [ "$networks" != "null" ]; then
            for network in $networks; do
                if [[ "$network" =~ ^(bridge|host|none)$ ]]; then
                    run_cmd="$run_cmd --network $network"
                else
                    if ! docker network inspect "$network" >/dev/null 2>&1; then
                        echo "创建网络: $network"
                        if ! docker network create "$network"; then
                            echo -e "${RED}创建网络失败: $network${NC}"
                            continue
                        fi
                    fi
                    run_cmd="$run_cmd --network $network"
                fi
            done
        fi
        
        # 添加入口点
        entrypoint=($(echo "$config" | jq -r '.[0].Config.Entrypoint[]' 2>/dev/null))
        if [ ${#entrypoint[@]} -gt 0 ] && [ "${entrypoint[0]}" != "null" ]; then
            run_cmd="$run_cmd --entrypoint \"${entrypoint[0]}\""
        fi
        
        # 添加镜像
        run_cmd="$run_cmd $image"
        
        # 添加命令
        cmd=($(echo "$config" | jq -r '.[0].Config.Cmd[]' 2>/dev/null))
        if [ ${#cmd[@]} -gt 0 ] && [ "${cmd[0]}" != "null" ]; then
            for arg in "${cmd[@]}"; do
                if [[ "$arg" == *" "* ]] || [[ "$arg" == *"$"* ]] || [[ "$arg" == *"&"* ]] || [[ "$arg" == *"|"* ]]; then
                    run_cmd="$run_cmd \"$arg\""
                else
                    run_cmd="$run_cmd $arg"
                fi
            done
        fi
        
        # 执行运行命令
        echo "执行命令: $run_cmd"
        if eval "$run_cmd"; then
            echo -e "${GREEN}成功恢复容器: $container_name${NC}"
            echo "容器状态:"
            docker ps -a --filter "name=$container_name" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        else
            echo -e "${RED}恢复容器失败: $container_name${NC}"
            echo "容器日志:"
            docker logs "$container_name" 2>&1 || true
            echo "容器状态:"
            docker ps -a --filter "name=$container_name" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
        fi
    done
}

# 恢复 Docker 卷
restore_volumes() {
    local backup_dir="$1"
    local volumes_dir="$backup_dir/volumes"
    
    if [ ! -d "$volumes_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到卷目录${NC}"
        return 1
    fi
    
    # 获取备份目录的绝对路径
    local backup_dir_abs=$(cd "$backup_dir" && pwd)
    local volumes_dir_abs="$backup_dir_abs/volumes"
    
    # 检查卷名映射文件
    local map_file="$volumes_dir/volume_map.txt"
    if [ ! -f "$map_file" ]; then
        echo -e "${RED}错误: 未找到卷名映射文件${NC}"
        return 1
    fi
    
    # 获取所有备份的卷文件
    local volume_files=($(ls "$volumes_dir"/*.tar.gz 2>/dev/null))
    if [ ${#volume_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的卷${NC}"
        return 1
    fi
    
    # 显示可恢复的卷列表
    echo -e "\n${YELLOW}可恢复的卷列表:${NC}"
    printf "\n%s\n" "===================================================="
    echo -e "${GREEN}编号\t原始卷名\t\t\t\t备份文件名${NC}"
    printf "%s\n" "----------------------------------------------------"
    echo -e "0\t[全选]"
    printf "%s\n" "----------------------------------------------------"
    
    # 创建卷名映射数组
    declare -A volume_map
    while IFS='=' read -r original_name safe_name; do
        # 跳过注释和空行
        [[ "$original_name" =~ ^#.*$ ]] && continue
        [[ -z "$original_name" ]] && continue
        volume_map["$safe_name"]="$original_name"
    done < "$map_file"
    
    local i=1
    for vol_file in "${volume_files[@]}"; do
        safe_name=$(basename "$vol_file" .tar.gz)
        original_name="${volume_map[$safe_name]}"
        if [ -z "$original_name" ]; then
            original_name="未知卷名"
        fi
        echo -e "$i\t$original_name\t$safe_name"
        i=$((i+1))
    done
    printf "\n%s\n" "===================================================="
    
    # 获取用户选择
    read -p "请选择要恢复的卷编号（多个编号用空格分隔，输入 0 选择所有卷）: " choices
    
    # 处理选择
    local selected=()
    if [[ "$choices" == "0" ]]; then
        selected=("${volume_files[@]}")
    else
        for choice in $choices; do
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -le "${#volume_files[@]}" ]; then
                selected+=("${volume_files[$((choice-1))]}")
            else
                echo -e "${RED}无效的选择: $choice${NC}"
            fi
        done
    fi
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何卷${NC}"
        return 1
    fi
    
    # 显示已选择的卷
    echo -e "\n${GREEN}已选择的卷:${NC}"
    printf "\n%s\n" "===================================================="
    for vol_file in "${selected[@]}"; do
        safe_name=$(basename "$vol_file" .tar.gz)
        original_name="${volume_map[$safe_name]}"
        if [ -z "$original_name" ]; then
            original_name="未知卷名"
        fi
        echo -e "$original_name (备份文件: $safe_name)"
    done
    printf "\n%s\n" "===================================================="
    
    # 确认恢复
    if ! confirm "确认恢复以上卷？"; then
        return 1
    fi
    
    # 开始恢复
    echo "正在恢复选中的卷..."
    for vol_file in "${selected[@]}"; do
        safe_name=$(basename "$vol_file" .tar.gz)
        original_name="${volume_map[$safe_name]}"
        if [ -z "$original_name" ]; then
            echo -e "${RED}错误: 无法找到卷 $safe_name 的原始名称${NC}"
            continue
        fi
        
        echo "恢复卷: $original_name (从备份文件: $safe_name)"
        
        # 检查卷是否已存在
        if docker volume inspect "$original_name" >/dev/null 2>&1; then
            echo -e "${YELLOW}卷 $original_name 已存在${NC}"
            if ! confirm "是否删除已存在的卷？"; then
                echo -e "${YELLOW}跳过卷: $original_name${NC}"
                continue
            fi
            
            # 检查是否有容器使用此卷
            containers=$(docker ps -a --filter volume="$original_name" --format "{{.Names}}")
            if [ ! -z "$containers" ]; then
                echo -e "${YELLOW}警告: 以下容器正在使用此卷:${NC}"
                echo "$containers"
                if ! confirm "是否停止并删除这些容器？"; then
                    echo -e "${YELLOW}跳过卷: $original_name${NC}"
                    continue
                fi
                
                # 停止并删除使用此卷的容器
                for container in $containers; do
                    echo "停止并删除容器: $container"
                    docker stop "$container" 2>/dev/null
                    docker rm -f "$container" || {
                        echo -e "${RED}删除容器失败: $container${NC}"
                        continue
                    }
                done
            fi
            
            # 删除已存在的卷
            echo "删除已存在的卷: $original_name"
            docker volume rm "$original_name" || {
                echo -e "${RED}删除卷失败: $original_name${NC}"
                continue
            }
        fi
        
        # 创建新卷
        echo "创建新卷: $original_name"
        if ! docker volume create "$original_name"; then
            echo -e "${RED}创建卷失败: $original_name${NC}"
            continue
        fi
        
        # 恢复卷数据
        echo "恢复卷数据..."
        if docker run --rm \
            -v "$original_name:/target" \
            -v "$volumes_dir_abs:/backup" \
            alpine sh -c "cd /target && tar xzf /backup/$safe_name.tar.gz"; then
            echo -e "${GREEN}成功恢复卷: $original_name${NC}"
        else
            echo -e "${RED}恢复卷数据失败: $original_name${NC}"
            # 清理失败的卷
            docker volume rm "$original_name" 2>/dev/null
        fi
    done
    echo -e "${GREEN}卷恢复完成${NC}"
}

# 恢复网络配置
restore_networks() {
    local backup_dir="$1"
    local networks_dir="$backup_dir/networks"
    
    if [ ! -d "$networks_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到网络配置目录${NC}"
        return 1
    fi
    
    # 获取所有备份的网络配置文件
    local network_files=($(ls "$networks_dir"/*.json 2>/dev/null))
    if [ ${#network_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的网络配置${NC}"
        return 1
    fi
    
    # 显示可恢复的网络列表
    echo -e "\n${YELLOW}可恢复的网络配置列表:${NC}"
    printf "\n%s\n" "===================================================="
    echo -e "${GREEN}编号\t网络配置${NC}"
    printf "%s\n" "----------------------------------------------------"
    echo -e "0\t[全选]"
    printf "%s\n" "----------------------------------------------------"
    
    local i=1
    for network_file in "${network_files[@]}"; do
        echo -e "$i\t$(basename "$network_file")"
        i=$((i+1))
    done
    printf "\n%s\n" "===================================================="
    
    # 获取用户选择
    read -p "请选择要恢复的网络配置编号（多个编号用空格分隔，输入 0 选择所有配置）: " choices
    
    # 处理选择
    local selected=()
    if [[ "$choices" == "0" ]]; then
        selected=("${network_files[@]}")
    else
        for choice in $choices; do
            if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -le "${#network_files[@]}" ]; then
                selected+=("${network_files[$((choice-1))]}")
            else
                echo -e "${RED}无效的选择: $choice${NC}"
            fi
        done
    fi
    
    if [ ${#selected[@]} -eq 0 ]; then
        echo -e "${RED}未选择任何网络配置${NC}"
        return 1
    fi
    
    # 显示已选择的网络配置
    echo -e "\n${GREEN}已选择的网络配置:${NC}"
    printf "\n%s\n" "===================================================="
    for network_file in "${selected[@]}"; do
        echo -e "$(basename "$network_file")"
    done
    printf "\n%s\n" "===================================================="
    
    # 确认恢复
    if ! confirm "确认恢复以上网络配置？"; then
        return 1
    fi
    
    # 开始恢复
    echo "正在恢复选中的网络配置..."
    for network_file in "${selected[@]}"; do
        network_name=$(basename "$network_file" .json)
        echo "恢复网络配置: $network_name"
        
        # 检查是否是预定义网络
        if [[ "$network_name" =~ ^(bridge|host|none)$ ]]; then
            echo -e "${YELLOW}跳过预定义网络: $network_name${NC}"
            continue
        fi
        
        # 检查网络是否已存在
        if docker network inspect "$network_name" >/dev/null 2>&1; then
            echo -e "${YELLOW}网络 $network_name 已存在${NC}"
            if ! confirm "是否删除已存在的网络？"; then
                echo -e "${YELLOW}跳过网络: $network_name${NC}"
                continue
            fi
            
            # 检查是否有容器使用此网络
            containers=$(docker network inspect "$network_name" -f '{{range .Containers}}{{.Name}} {{end}}')
            if [ ! -z "$containers" ]; then
                echo -e "${YELLOW}警告: 以下容器正在使用此网络:${NC}"
                echo "$containers"
                if ! confirm "是否断开这些容器的网络连接？"; then
                    echo -e "${YELLOW}跳过网络: $network_name${NC}"
                    continue
                fi
                
                # 断开所有容器的网络连接
                for container in $containers; do
                    echo "断开容器 $container 的网络连接"
                    docker network disconnect "$network_name" "$container" || {
                        echo -e "${RED}断开容器网络连接失败: $container${NC}"
                        continue
                    }
                done
            fi
            
            # 删除已存在的网络
            echo "删除已存在的网络: $network_name"
            docker network rm "$network_name" || {
                echo -e "${RED}删除网络失败: $network_name${NC}"
                continue
            }
        fi
        
        # 读取网络配置
        config=$(cat "$network_file")
        
        # 提取网络类型和配置
        driver=$(echo "$config" | jq -r '.[0].Driver')
        options=$(echo "$config" | jq -r '.[0].Options // {}')
        
        # 构建创建网络的命令
        create_cmd="docker network create --driver $driver"
        
        # 添加网络选项
        if [ "$options" != "null" ] && [ "$options" != "{}" ]; then
            for key in $(echo "$options" | jq -r 'keys[]'); do
                value=$(echo "$options" | jq -r --arg k "$key" '.[$k]')
                create_cmd="$create_cmd --opt $key=$value"
            done
        fi
        
        # 添加网络名称
        create_cmd="$create_cmd $network_name"
        
        # 创建网络
        echo "执行命令: $create_cmd"
        if eval "$create_cmd"; then
            echo -e "${GREEN}成功恢复网络: $network_name${NC}"
        else
            echo -e "${RED}恢复网络失败: $network_name${NC}"
        fi
    done
    echo -e "${GREEN}网络配置恢复完成${NC}"
}

# 执行完整恢复流程
full_restore() {
    local backup_dir="$1"
    
    if [ ! -d "$backup_dir" ]; then
        echo -e "${RED}错误: 备份目录不存在${NC}"
        return 1
    fi
    
    echo -e "\n${YELLOW}开始恢复流程${NC}"
    echo "备份目录: $backup_dir"
    
    # 检查备份信息
    if [ -f "$backup_dir/backup_info.txt" ]; then
        echo -e "\n${GREEN}备份信息:${NC}"
        cat "$backup_dir/backup_info.txt"
    fi
    
    # 确认恢复
    if ! confirm "确认开始恢复流程？"; then
        return 1
    fi
    
    # 按顺序恢复各个组件
    echo -e "\n${YELLOW}1. 恢复 Docker 镜像${NC}"
    restore_images "$backup_dir"
    
    echo -e "\n${YELLOW}2. 恢复 Docker 卷${NC}"
    restore_volumes "$backup_dir"
    
    echo -e "\n${YELLOW}3. 恢复网络配置${NC}"
    restore_networks "$backup_dir"
    
    echo -e "\n${YELLOW}4. 恢复容器配置${NC}"
    restore_containers "$backup_dir"
    
    echo -e "\n${GREEN}恢复流程完成${NC}"
}

# 执行完整恢复流程（无需确认）
full_restore_no_confirm() {
    local backup_dir="$1"
    export NO_CONFIRM=1  # 设置无需确认标志
    
    if [ ! -d "$backup_dir" ]; then
        echo -e "${RED}错误: 备份目录不存在${NC}"
        return 1
    fi
    
    echo -e "\n${YELLOW}开始恢复流程（无需确认）${NC}"
    echo "备份目录: $backup_dir"
    
    # 检查备份信息
    if [ -f "$backup_dir/backup_info.txt" ]; then
        echo -e "\n${GREEN}备份信息:${NC}"
        cat "$backup_dir/backup_info.txt"
    fi
    
    # 按顺序恢复各个组件
    echo -e "\n${YELLOW}1. 恢复 Docker 镜像${NC}"
    restore_images_no_confirm "$backup_dir"
    
    echo -e "\n${YELLOW}2. 恢复 Docker 卷${NC}"
    restore_volumes_no_confirm "$backup_dir"
    
    echo -e "\n${YELLOW}3. 恢复网络配置${NC}"
    restore_networks_no_confirm "$backup_dir"
    
    echo -e "\n${YELLOW}4. 恢复容器配置${NC}"
    restore_containers_no_confirm "$backup_dir"
    
    echo -e "\n${GREEN}恢复流程完成${NC}"
    unset NO_CONFIRM  # 清除无需确认标志
}

# 无需确认的镜像恢复
restore_images_no_confirm() {
    local backup_dir="$1"
    local images_dir="$backup_dir/images"
    
    if [ ! -d "$images_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到镜像目录${NC}"
        return 1
    fi
    
    # 获取所有备份的镜像文件
    local image_files=($(ls "$images_dir"/*.tar.gz 2>/dev/null))
    if [ ${#image_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的镜像${NC}"
        return 1
    fi
    
    echo "正在恢复所有镜像..."
    for img_file in "${image_files[@]}"; do
        echo "恢复镜像: $(basename "$img_file")"
        if gunzip -c "$img_file" | docker load; then
            echo -e "${GREEN}成功恢复镜像: $(basename "$img_file")${NC}"
        else
            echo -e "${RED}恢复镜像失败: $(basename "$img_file")${NC}"
        fi
    done
}

# 无需确认的卷恢复
restore_volumes_no_confirm() {
    local backup_dir="$1"
    local volumes_dir="$backup_dir/volumes"
    
    if [ ! -d "$volumes_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到卷目录${NC}"
        return 1
    fi
    
    # 检查卷名映射文件
    local map_file="$volumes_dir/volume_map.txt"
    if [ ! -f "$map_file" ]; then
        echo -e "${RED}错误: 未找到卷名映射文件${NC}"
        return 1
    fi
    
    # 获取所有备份的卷文件
    local volume_files=($(ls "$volumes_dir"/*.tar.gz 2>/dev/null))
    if [ ${#volume_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的卷${NC}"
        return 1
    fi
    
    # 创建卷名映射数组
    declare -A volume_map
    while IFS='=' read -r original_name safe_name; do
        [[ "$original_name" =~ ^#.*$ ]] && continue
        [[ -z "$original_name" ]] && continue
        volume_map["$safe_name"]="$original_name"
    done < "$map_file"
    
    echo "正在恢复所有卷..."
    for vol_file in "${volume_files[@]}"; do
        safe_name=$(basename "$vol_file" .tar.gz)
        original_name="${volume_map[$safe_name]}"
        if [ -z "$original_name" ]; then
            echo -e "${RED}错误: 无法找到卷 $safe_name 的原始名称${NC}"
            continue
        fi
        
        echo "恢复卷: $original_name (从备份文件: $safe_name)"
        
        # 检查卷是否已存在
        if docker volume inspect "$original_name" >/dev/null 2>&1; then
            echo "删除已存在的卷: $original_name"
            docker volume rm "$original_name" || {
                echo -e "${RED}删除卷失败: $original_name${NC}"
                continue
            }
        fi
        
        # 创建新卷
        echo "创建新卷: $original_name"
        if ! docker volume create "$original_name"; then
            echo -e "${RED}创建卷失败: $original_name${NC}"
            continue
        fi
        
        # 获取卷的挂载点
        volume_path=$(docker volume inspect -f '{{.Mountpoint}}' "$original_name")
        if [ -z "$volume_path" ]; then
            echo -e "${RED}无法获取卷挂载点: $original_name${NC}"
            docker volume rm "$original_name" 2>/dev/null
            continue
        fi
        
        # 直接使用 tar 命令恢复
        echo "恢复卷数据..."
        if tar -xzf "$vol_file" -C "$volume_path"; then
            echo -e "${GREEN}成功恢复卷: $original_name${NC}"
        else
            echo -e "${RED}恢复卷数据失败: $original_name${NC}"
            docker volume rm "$original_name" 2>/dev/null
        fi
    done
}

# 无需确认的网络恢复
restore_networks_no_confirm() {
    local backup_dir="$1"
    local networks_dir="$backup_dir/networks"
    
    if [ ! -d "$networks_dir" ]; then
        echo -e "${RED}错误: 备份目录中未找到网络配置目录${NC}"
        return 1
    fi
    
    # 获取所有备份的网络配置文件
    local network_files=($(ls "$networks_dir"/*.json 2>/dev/null))
    if [ ${#network_files[@]} -eq 0 ]; then
        echo -e "${YELLOW}没有找到任何备份的网络配置${NC}"
        return 1
    fi
    
    echo "正在恢复所有网络配置..."
    for network_file in "${network_files[@]}"; do
        network_name=$(basename "$network_file" .json)
        echo "恢复网络配置: $network_name"
        
        # 检查是否是预定义网络
        if [[ "$network_name" =~ ^(bridge|host|none)$ ]]; then
            echo -e "${YELLOW}跳过预定义网络: $network_name${NC}"
            continue
        fi
        
        # 检查网络是否已存在
        if docker network inspect "$network_name" >/dev/null 2>&1; then
            echo "删除已存在的网络: $network_name"
            docker network rm "$network_name" || {
                echo -e "${RED}删除网络失败: $network_name${NC}"
                continue
            }
        fi
        
        # 读取网络配置
        config=$(cat "$network_file")
        
        # 提取网络类型和配置
        driver=$(echo "$config" | jq -r '.[0].Driver')
        options=$(echo "$config" | jq -r '.[0].Options // {}')
        
        # 构建创建网络的命令
        create_cmd="docker network create --driver $driver"
        
        # 添加网络选项
        if [ "$options" != "null" ] && [ "$options" != "{}" ]; then
            for key in $(echo "$options" | jq -r 'keys[]'); do
                value=$(echo "$options" | jq -r --arg k "$key" '.[$k]')
                create_cmd="$create_cmd --opt $key=$value"
            done
        fi
        
        # 添加网络名称
        create_cmd="$create_cmd $network_name"
        
        # 创建网络
        echo "执行命令: $create_cmd"
        if eval "$create_cmd"; then
            echo -e "${GREEN}成功恢复网络: $network_name${NC}"
        else
            echo -e "${RED}恢复网络失败: $network_name${NC}"
        fi
    done
}

# 无需确认的容器恢复
restore_containers_no_confirm() {
    echo "正在恢复容器配置..."
    
    # 首先恢复所有镜像
    echo "正在恢复所需的镜像..."
    for img_file in "$BACKUP_DIR/images"/*.tar.gz; do
        if [ -f "$img_file" ]; then
            echo "恢复镜像: $(basename "$img_file")"
            gunzip -c "$img_file" | docker load
        fi
    done
    
    # 然后恢复容器
    for container_file in "$BACKUP_DIR/containers"/*.json; do
        # 跳过 .metadata.json 文件
        if [[ "$container_file" == *.metadata.json ]]; then
            continue
        fi
        
        if [ -f "$container_file" ]; then
            container_name=$(basename "$container_file" .json)
            echo "恢复容器: $container_name"
            
            # 检查并删除已存在的同名容器
            if docker ps -a --format "{{.Names}}" | grep -q "^${container_name}$"; then
                echo "删除已存在的容器: $container_name"
                docker rm -f "$container_name" || {
                    echo -e "${RED}删除容器失败: $container_name${NC}"
                    continue
                }
            fi
            
            # 从备份文件中读取容器配置
            container_config=$(cat "$container_file")
            
            # 提取容器配置
            image=$(echo "$container_config" | jq -r '.[0].Config.Image')
            
            # 检查镜像是否存在
            if ! docker image inspect "$image" >/dev/null 2>&1; then
                echo -e "${RED}错误: 镜像 $image 不存在${NC}"
                continue
            fi
            
            # 构建运行命令
            run_cmd="docker run -d --name $container_name"
            
            # 添加端口映射
            ports=$(echo "$container_config" | jq -r '.[0].HostConfig.PortBindings | to_entries[] | "-p \(.value[0].HostPort):\(.key | split("/")[0])"')
            if [ ! -z "$ports" ]; then
                for port in $ports; do
                    run_cmd="$run_cmd $port"
                done
            fi
            
            # 添加卷挂载
            volumes=$(echo "$container_config" | jq -r '.[0].Mounts[] | "-v \(.Source):\(.Destination)"')
            if [ ! -z "$volumes" ]; then
                for volume in $volumes; do
                    run_cmd="$run_cmd $volume"
                done
            fi
            
            # 添加环境变量
            env_vars=$(echo "$container_config" | jq -r '.[0].Config.Env[]')
            if [ ! -z "$env_vars" ]; then
                for env_var in $env_vars; do
                    run_cmd="$run_cmd -e \"$env_var\""
                done
            fi
            
            # 添加网络
            network=$(echo "$container_config" | jq -r '.[0].NetworkSettings.Networks | keys[0]')
            if [ ! -z "$network" ] && [ "$network" != "null" ]; then
                run_cmd="$run_cmd --network $network"
            fi
            
            # 添加入口点
            entrypoint=$(echo "$container_config" | jq -r '.[0].Config.Entrypoint[]')
            if [ ! -z "$entrypoint" ] && [ "$entrypoint" != "null" ]; then
                run_cmd="$run_cmd --entrypoint \"$entrypoint\""
            fi
            
            # 添加镜像
            run_cmd="$run_cmd $image"
            
            # 添加命令
            cmd=$(echo "$container_config" | jq -r '.[0].Config.Cmd[]')
            if [ ! -z "$cmd" ] && [ "$cmd" != "null" ]; then
                for arg in $cmd; do
                    if [[ "$arg" == *" "* ]] || [[ "$arg" == *"$"* ]] || [[ "$arg" == *"&"* ]] || [[ "$arg" == *"|"* ]]; then
                        run_cmd="$run_cmd \"$arg\""
                    else
                        run_cmd="$run_cmd $arg"
                    fi
                done
            fi
            
            # 执行运行命令
            echo "执行命令: $run_cmd"
            eval "$run_cmd"
            
            # 检查容器是否成功启动
            if [ $? -eq 0 ]; then
                echo -e "${GREEN}成功恢复容器: $container_name${NC}"
                echo "容器状态:"
                docker ps -a --filter "name=$container_name" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
            else
                echo -e "${RED}恢复容器失败: $container_name${NC}"
                echo "容器日志:"
                docker logs "$container_name" 2>&1 || true
            fi
        fi
    done
    echo -e "${GREEN}容器恢复完成${NC}"
}

# 显示恢复菜单
show_restore_menu() {
    clear
    echo -e "${GREEN}Docker 恢复工具${NC}"
    printf "\n%s\n" "===================================================="
    echo "1. 恢复 Docker 镜像"
    echo "2. 恢复 Docker 卷"
    echo "3. 恢复网络配置"
    echo "4. 恢复容器配置"
    echo "5. 执行完整恢复流程"
    echo "0. 返回主菜单"
    printf "\n%s\n" "===================================================="
    printf "\n%s" "请选择操作 (0-5): "
}

# 主程序
# 检查参数
if [ $# -lt 1 ]; then
    echo -e "${RED}使用方法: $0 [预设选项] <备份目录路径>${NC}"
    echo "示例: $0 10 /back-xx/docker_backup"
    echo "预设选项:"
    echo "  1 - 显示当前 Docker 状态"
    echo "  2 - 停止所有容器"
    echo "  3 - 备份 Docker 镜像"
    echo "  4 - 备份容器配置"
    echo "  5 - 备份 Docker 卷"
    echo "  6 - 备份网络配置"
    echo "  7 - 备份 Docker 配置文件"
    echo "  8 - 执行完整备份流程"
    echo "  88 - 执行完整备份流程（无需确认）"
    echo "  9 - 恢复容器状态"
    echo "  99 - 恢复容器状态（无需确认）"
    exit 1
fi

# 检查依赖
if ! check_dependencies; then
    exit 1
fi

# 设置备份目录和预设选项
if [ $# -eq 1 ]; then
    # 只有一个参数时，作为备份目录
    BACKUP_DIR="$1"
    PRESET_OPTION=""
else
    # 两个参数时，第一个是预设选项，第二个是备份目录
    PRESET_OPTION="$1"
    BACKUP_DIR="$2"
fi

if [ ! -d "$BACKUP_DIR" ]; then
    echo -e "${YELLOW}备份目录不存在，正在创建: $BACKUP_DIR${NC}"
    mkdir -p "$BACKUP_DIR"
fi

# 创建必要的子目录
mkdir -p "$BACKUP_DIR/images"
mkdir -p "$BACKUP_DIR/containers"
mkdir -p "$BACKUP_DIR/volumes"
mkdir -p "$BACKUP_DIR/networks"
mkdir -p "$BACKUP_DIR/config"

# 创建日志文件
LOG_FILE="$BACKUP_DIR/backup.log"
exec 1> >(tee -a "$LOG_FILE")
exec 2> >(tee -a "$LOG_FILE" >&2)

# 记录运行中的容器
RUNNING_CONTAINERS=$(docker ps -q)

# 处理预设选项
if [ ! -z "$PRESET_OPTION" ]; then
    case "$PRESET_OPTION" in
        "1")
            echo "显示当前 Docker 状态..."
            show_docker_status
            exit $?
            ;;
        "2")
            echo "停止所有容器..."
            stop_containers
            exit $?
            ;;
        "3")
            echo "备份 Docker 镜像..."
            backup_images
            exit $?
            ;;
        "4")
            echo "备份容器配置..."
            backup_containers
            exit $?
            ;;
        "5")
            echo "备份 Docker 卷..."
            backup_volumes
            exit $?
            ;;
        "6")
            echo "备份网络配置..."
            backup_networks
            exit $?
            ;;
        "7")
            echo "备份 Docker 配置文件..."
            backup_config
            exit $?
            ;;
        "8")
            echo "执行完整备份流程..."
            full_backup
            exit $?
            ;;
        "88")
            echo "执行完整备份流程（无需确认）..."
            full_backup_no_confirm
            exit $?
            ;;
        "9")
            echo "恢复容器状态..."
            restore_containers "$BACKUP_DIR"
            exit $?
            ;;
        "99")
            echo "恢复容器状态（无需确认）..."
            restore_containers_no_confirm "$BACKUP_DIR"
            exit $?
            ;;
        *)
            echo -e "${RED}错误: 未知的预设选项: $PRESET_OPTION${NC}"
            echo "可用的预设选项:"
            echo "  1 - 显示当前 Docker 状态"
            echo "  2 - 停止所有容器"
            echo "  3 - 备份 Docker 镜像"
            echo "  4 - 备份容器配置"
            echo "  5 - 备份 Docker 卷"
            echo "  6 - 备份网络配置"
            echo "  7 - 备份 Docker 配置文件"
            echo "  8 - 执行完整备份流程"
            echo "  88 - 执行完整备份流程（无需确认）"
            echo "  9 - 恢复容器状态"
            echo "  99 - 恢复容器状态（无需确认）"
            exit 1
            ;;
    esac
fi

# 主循环
while true; do
    show_menu
    read choice
    case $choice in
        1) show_docker_status ;;
        2) stop_containers ;;
        3) backup_images ;;
        4) backup_containers ;;
        5) backup_volumes ;;
        6) backup_networks ;;
        7) backup_config ;;
        8) 
            # 显示恢复菜单
            while true; do
                show_restore_menu
                read restore_choice
                case $restore_choice in
                    1) restore_images "$BACKUP_DIR" ;;
                    2) restore_volumes "$BACKUP_DIR" ;;
                    3) restore_networks "$BACKUP_DIR" ;;
                    4) restore_containers "$BACKUP_DIR" ;;
                    5) full_restore "$BACKUP_DIR" ;;
                    0) break ;;
                    *) echo -e "${RED}无效的选择，请重试${NC}" ;;
                esac
                read -p "按回车键继续..."
            done
            ;;
        88)
            echo "执行完整恢复流程（无需确认）..."
            full_restore_no_confirm "$BACKUP_DIR"
            ;;
        9) full_backup ;;
        99) 
            echo "执行完整备份流程（无需确认）..."
            full_backup_no_confirm
            ;;
        0) 
            if [ ! -z "$RUNNING_CONTAINERS" ]; then
                if confirm "有容器处于停止状态，是否在退出前恢复它们？"; then
                    restore_containers
                fi
            fi
            echo -e "${GREEN}退出程序${NC}"
            exit 0
            ;;
        *) echo -e "${RED}无效的选择，请重试${NC}" ;;
    esac
    read -p "按回车键继续..."
done 