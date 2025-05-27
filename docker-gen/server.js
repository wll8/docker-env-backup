const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9090;
const BASE_DIR = './file';
const LOG = `./log/req.txt`
if(fs.existsSync(LOG) && fs.statSync(LOG).isDirectory()) {
  console.error(`请挂载文件`)
  process.exit()
}

// 递归创建目录
function ensureDirSync(dirPath) {
  if (dirPath === BASE_DIR || fs.existsSync(dirPath)) {
    return;
  }
  ensureDirSync(path.dirname(dirPath));
  fs.mkdirSync(dirPath);
}

// 写入日志函数
function writeLog(url) {
  ensureDirSync(path.dirname(LOG));
  fs.appendFileSync(LOG, url + '\n');
}

const server = http.createServer((req, res) => {
  const name = process.env.NAME || 'unknown';
  writeLog(req.url);
  
  // 解析URL和查询参数
  const url = new URL(req.url, `http://${req.headers.host}`);
  const filePath = path.join(BASE_DIR, url.pathname.replace(/^\/file\//, ''));
  const query = Object.fromEntries(url.searchParams);

  // 处理 ping 请求
  if (url.pathname === '/ping') {
    // 如果有目标URL，则进行转发
    if (query.url) {
      const targetUrl = query.url.startsWith('http') ? query.url : `http://${query.url}`;
      console.log(`${name} 正在请求: ${targetUrl}`);
      
      http.get(targetUrl, (targetRes) => {
        let data = '';
        targetRes.on('data', (chunk) => {
          data += chunk;
        });
        targetRes.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            from: name,
            to: query.url,
            response: JSON.parse(data)
          }));
        });
      }).on('error', (err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: err.message,
          from: name,
          to: query.url
        }));
      });
      return;
    }

    // 直接返回 ping 响应
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      message: `Hello from ${name}`,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // 处理文件操作请求
  if (url.pathname.startsWith('/file/')) {
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
    return;
  }

  // 处理其他请求
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    message: `Hello from ${name}`,
    timestamp: new Date().toISOString()
  }));
});

server.listen(PORT, () => {
  console.log(`Server ${process.env.NAME || 'unknown'} running on port ${PORT}`);
  console.log(`Base directory: ${BASE_DIR}`);
  console.log(`Log file: ${LOG}`);
}); 