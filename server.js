const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const si = require('systeminformation');
const mysql = require('mysql2/promise');
const axios = require('axios'); // 👈 เพิ่ม axios สำหรับส่ง Telegram
const os = require('os');

// ==========================================
// ⚙️ ตั้งค่า Telegram Bot
// ==========================================
const TELEGRAM_TOKEN = '8841262472:AAE05Ntud0F8_L5BswSeYmycup3Qtm5Wz50';
const TELEGRAM_CHAT_ID = '7754054025';

// ฟังก์ชันสำหรับส่งข้อความเข้า Telegram
async function sendTelegramAlert(message) {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message
        });
        console.log('📲 ส่งแจ้งเตือน Telegram สำเร็จ!');
    } catch (err) {
        console.error('❌ ส่ง Telegram ไม่สำเร็จ:', err.message);
    }
}

// 🛡️ ระบบหน่วงเวลาแจ้งเตือน (Cooldown) ป้องกันการ Spam
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // ตั้งไว้ 5 นาที (แก้ไขได้)
let lastCpuAlertTime = 0;
let serviceAlertStatus = {}; // เก็บเวลาที่แจ้งเตือนของแต่ละ Service

// ==========================================
// ⚙️ ตั้งค่า Database
// ==========================================
const dbPool = mysql.createPool({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'p@ssword',
    database: 'server_monitor_db',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

io.on('connection', (socket) => {
    console.log('💻 มีคนเปิดหน้า Dashboard แล้ว!');

    const interval = setInterval(async () => {
        try {
            // 1. ดึงข้อมูลระบบ
            const cpuLoad = await si.currentLoad();
            const mem = await si.mem();
            const usedMemPercent = ((mem.active / mem.total) * 100).toFixed(2);
            const disk = await si.fsSize();
            const diskUsedPercent = disk && disk.length > 0 ? disk[0].use.toFixed(2) : 0;
            const network = await si.networkStats();
            const rxSec = network && network.length > 0 ? (network[0].rx_sec / 1024 / 1024).toFixed(2) : 0;
            const txSec = network && network.length > 0 ? (network[0].tx_sec / 1024 / 1024).toFixed(2) : 0;
            const time = await si.time();
            const uptimeHours = (time.uptime / 3600).toFixed(1);
            const servicesData = await si.services('nginx, php-fpm, mariadb, node').catch(() => []);

            // 2. ตรวจสอบเงื่อนไขแจ้งเตือน (Alert Logic)
            const now = Date.now();

            // 🚨 แจ้งเตือนเมื่อ CPU เกิน 90%
            if (cpuLoad.currentLoad > 90) {
                if (now - lastCpuAlertTime > ALERT_COOLDOWN_MS) {
                    sendTelegramAlert(`🚨 [คำเตือน] CPU โหลดหนักมาก!\nตอนนี้การใช้งานพุ่งไปที่ ${cpuLoad.currentLoad.toFixed(2)}% แล้วครับ`);
                    lastCpuAlertTime = now;
                }
            } else if (cpuLoad.currentLoad < 80) {
                // ถ้าระบบกลับมาปกติ ให้รีเซ็ตเวลา จะได้เตือนใหม่ได้ทันทีในครั้งหน้า
                lastCpuAlertTime = 0; 
            }

            // ❌ แจ้งเตือน Service หยุดทำงาน (ทำงานเฉพาะบน Linux เท่านั้น)
            if (os.platform() === 'linux') {
                if (servicesData && servicesData.length > 0) {
                    servicesData.forEach(service => {
                        if (!service.running) { 
                            const lastAlert = serviceAlertStatus[service.name] || 0;
                            if (now - lastAlert > ALERT_COOLDOWN_MS) {
                                sendTelegramAlert(`❌ [ฉุกเฉิน] Service ร่วง!\nระบบ ${service.name.toUpperCase()} หยุดทำงาน กรุณาตรวจสอบด่วนครับ`);
                                serviceAlertStatus[service.name] = now;
                            }
                        } else {
                            if (serviceAlertStatus[service.name]) {
                                sendTelegramAlert(`✅ [กลับสู่สภาวะปกติ]\nระบบ ${service.name.toUpperCase()} กลับมาทำงานปกติแล้วครับ`);
                                delete serviceAlertStatus[service.name];
                            }
                        }
                    });
                }
            } else {
                // ถ้าเป็น Windows หรือ Mac ให้ข้ามการแจ้งเตือน Service ไปก่อน จะได้เทสอย่างสงบสุข 555
            }

            // 3. ส่งข้อมูลไปที่หน้าเว็บ
            const serverData = {
                cpu: cpuLoad.currentLoad.toFixed(2),
                ram: usedMemPercent,
                disk: diskUsedPercent,
                netRx: rxSec,
                netTx: txSec,
                uptime: uptimeHours,
                services: servicesData
            };
            socket.emit('server-data', serverData);

            // 4. อัปเดตข้อมูลลง Database
            const sql = `
                INSERT INTO current_status 
                (server_name, cpu_percent, ram_percent, disk_percent, net_rx, net_tx, uptime_hrs) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                cpu_percent = VALUES(cpu_percent), 
                ram_percent = VALUES(ram_percent), 
                disk_percent = VALUES(disk_percent),
                net_rx = VALUES(net_rx),
                net_tx = VALUES(net_tx),
                uptime_hrs = VALUES(uptime_hrs)
            `;
            await dbPool.execute(sql, ['Main-Server', serverData.cpu, serverData.ram, serverData.disk, serverData.netRx, serverData.netTx, serverData.uptime]);

        } catch (error) {
            console.error('เกิดข้อผิดพลาด:', error);
        }
    }, 3000);

    socket.on('disconnect', () => {
        clearInterval(interval);
    });
});

// ... โค้ดส่วนบนเหมือนเดิม (ตัวแปรต่างๆ, ตั้งค่า Database, ฟังก์ชัน Telegram) ...

io.on('connection', async (socket) => {
    console.log('💻 มีคนเปิดหน้า Dashboard แล้ว!');

    // 🌟 [เพิ่มใหม่] ส่งข้อมูลประวัติย้อนหลัง 20 จุดล่าสุดให้หน้าเว็บทันทีที่เปิด
    try {
        const [rows] = await dbPool.execute(`
            SELECT cpu_percent, ram_percent 
            FROM history_log 
            WHERE server_name = 'Main-Server' 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        // ส่งข้อมูลประวัติผ่านท่อชื่อ 'initial-history'
        socket.emit('initial-history', rows);
    } catch (err) {
        console.error('ดึงประวัติผิดพลาด:', err.message);
    }

    const interval = setInterval(async () => {
        try {
            // ... (โค้ดดึงข้อมูล si.currentLoad(), si.mem() ฯลฯ เหมือนเดิม) ...
            const cpuLoad = await si.currentLoad();
            const mem = await si.mem();
            const usedMemPercent = ((mem.active / mem.total) * 100).toFixed(2);
            const disk = await si.fsSize();
            const diskUsedPercent = disk && disk.length > 0 ? disk[0].use.toFixed(2) : 0;
            const network = await si.networkStats();
            const rxSec = network && network.length > 0 ? (network[0].rx_sec / 1024 / 1024).toFixed(2) : 0;
            const txSec = network && network.length > 0 ? (network[0].tx_sec / 1024 / 1024).toFixed(2) : 0;
            const time = await si.time();
            const uptimeHours = (time.uptime / 3600).toFixed(1);
            const servicesData = await si.services('nginx, php-fpm, mariadb, node').catch(() => []);

            // ... (โค้ดแจ้งเตือน Telegram เหมือนเดิม) ...

            const serverData = {
                cpu: cpuLoad.currentLoad.toFixed(2),
                ram: usedMemPercent,
                disk: diskUsedPercent,
                netRx: rxSec,
                netTx: txSec,
                uptime: uptimeHours,
                services: servicesData
            };

            socket.emit('server-data', serverData);

            // 1. อัปเดตสถานะปัจจุบัน (ของเดิม)
            const sqlCurrent = `
                INSERT INTO current_status (server_name, cpu_percent, ram_percent, disk_percent, net_rx, net_tx, uptime_hrs) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                cpu_percent=VALUES(cpu_percent), ram_percent=VALUES(ram_percent), disk_percent=VALUES(disk_percent),
                net_rx=VALUES(net_rx), net_tx=VALUES(net_tx), uptime_hrs=VALUES(uptime_hrs)
            `;
            await dbPool.execute(sqlCurrent, ['Main-Server', serverData.cpu, serverData.ram, serverData.disk, serverData.netRx, serverData.netTx, serverData.uptime]);

            // 🌟 2. [เพิ่มใหม่] บันทึกประวัติลงตาราง history_log
            const sqlHistory = `INSERT INTO history_log (server_name, cpu_percent, ram_percent) VALUES (?, ?, ?)`;
            await dbPool.execute(sqlHistory, ['Main-Server', serverData.cpu, serverData.ram]);

        } catch (error) {
            console.error('เกิดข้อผิดพลาด:', error);
        }
    }, 3000);

    socket.on('disconnect', () => {
        clearInterval(interval);
    });
});

// ... โค้ดส่วนล่าง (server.listen) เหมือนเดิม ...

const PORT = 3000;
server.listen(PORT, async () => {
    try {
        const connection = await dbPool.getConnection();
        console.log('✅ เชื่อมต่อฐานข้อมูล MariaDB สำเร็จแล้ว!');
        connection.release();
    } catch (err) {
        console.error('❌ ไม่สามารถเชื่อมต่อฐานข้อมูลได้:', err.message);
    }
    console.log(`🚀 Server Monitor ทำงานปกติที่ http://localhost:${PORT}`);
    
    // ทดสอบส่งข้อความ 1 ครั้งตอนเปิดระบบ
    sendTelegramAlert('🚀 ระบบ Server Monitor เริ่มต้นทำงานแล้วครับ!');
});