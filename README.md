# Finance Tracker - 港股回购与分红追踪

## 项目简介
港股回购与分红追踪工具，数据来源于港交所官方。

## 功能
- 港股回购数据追踪
- 分红数据追踪
- 每日数据更新
- 数据可视化展示

## 技术栈
- 后端：Node.js + Express
- 前端：原生 HTML/CSS/JavaScript
- 数据缓存：文件缓存系统

## 本地运行
```bash
# 安装依赖
npm install

# 启动服务
npm start

# 默认端口：3000
```

## 部署
服务器使用 PM2 管理：
```bash
pm2 start server.js --name finance-tracker
pm2 save
```

## 修改指南
- `server.js` - 后端服务器和 API 路由
- `public/` - 前端静态文件
- `cache/` - 数据缓存目录

## 注意事项
- 修改路由时注意语法（字符串要加引号）
- 缓存数据有时效性
- 确保端口不冲突（默认3000）
