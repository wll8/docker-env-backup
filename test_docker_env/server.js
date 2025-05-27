const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const BASE_DIR = './file';

// 递归创建目录
function ensureDirSync(dirPath) {
  // 如果目录是 BASE_DIR 或已存在，直接返回
  if (dirPath === BASE_DIR || fs.existsSync(dirPath)) {
    return;
  }
  ensureDirSync(path.dirname(dirPath));
  fs.mkdirSync(dirPath);
}

const server = http.createServer((req, res) => {
  // 解析URL和查询参数
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = path.join(BASE_DIR, url.pathname.replace(/^\/file\//, ''));
  const query = Object.fromEntries(url.searchParams);

  // 检查文件路径是否在允许的目录内
  if (!url.pathname.startsWith('/file/')) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Access denied' }));
    return;
  }

  try {
    let old = {};
    // 如果文件存在，读取内容
    if (fs.existsSync(filePath)) {
      try {
        old = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        // 如果文件存在但内容不是有效的JSON，使用空对象
        old = {};
      }
    }

    // 如果有查询参数，则合并并写入文件
    if (Object.keys(query).length) {
      const newContent = { ...old, ...query };
      // 确保目录存在
      ensureDirSync(path.dirname(filePath));
      // 写入文件
      fs.writeFileSync(filePath, JSON.stringify(newContent, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(newContent));
    } else {
      // 没有查询参数，直接返回文件内容
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(old));
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Base directory: ${BASE_DIR}`);
}); 