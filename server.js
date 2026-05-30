require('dotenv').config();
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
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
const ALERT_COOLDOWN_MS = parseInt(process.env.ALERT_COOLDOWN_MS) || 5 * 60 * 1000; // ตั้งไว้ 5 นาที (แก้ไขได้)
let lastCpuAlertTime = 0;
let serviceAlertStatus = {}; // เก็บเวลาที่แจ้งเตือนของแต่ละ Service
let initiallyRunningServices = new Set(); // เก็บ Service ที่เคยทำงานตั้งแต่เริ่มระบบ

// ==========================================
// ⚙️ ตั้งค่า Database
// ==========================================
const dbPool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 3307,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'server_monitor_db',
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

io.on('connection', async (socket) => {
    console.log('💻 มีคนเปิดหน้า Dashboard แล้ว!');

    // 🌟 ส่งข้อมูลประวัติย้อนหลัง 20 จุดล่าสุดให้หน้าเว็บทันทีที่เปิด
    try {
        const [rows] = await dbPool.execute(`
            SELECT cpu_percent, ram_percent 
            FROM history_log 
            WHERE server_name = 'Main-Server' 
            ORDER BY created_at DESC 
            LIMIT 20
        `);
        socket.emit('initial-history', rows);
    } catch (err) {
        console.error('ดึงประวัติผิดพลาด:', err.message);
    }

    const interval = setInterval(async () => {
        try {
            // 1. ดึงข้อมูลระบบ
            const cpuLoad = await si.currentLoad();
            const cpuTemp = await si.cpuTemperature().catch(() => ({ main: 0 }));
            const mem = await si.mem();
            const usedMemPercent = ((mem.active / mem.total) * 100).toFixed(2);
            const disk = await si.fsSize();
            const diskUsedPercent = disk && disk.length > 0 ? disk[0].use.toFixed(2) : 0;
            
            // 🛠️ ข้าม diskIO และ networkStats บน Windows เพื่อลดภาระ CPU
            let diskIO = { rIO: 0, wIO: 0 };
            let rxSec = 0;
            let txSec = 0;
            if (os.platform() === 'linux') {
                diskIO = await si.disksIO().catch(() => null) || { rIO: 0, wIO: 0 };
                const network = await si.networkStats();
                rxSec = network && network.length > 0 ? (network[0].rx_sec / 1024 / 1024).toFixed(2) : 0;
                txSec = network && network.length > 0 ? (network[0].tx_sec / 1024 / 1024).toFixed(2) : 0;
            }
            
            const time = await si.time();
            const uptimeHours = (time.uptime / 3600).toFixed(1);
            const loadAvg = os.loadavg();
            
            // 🛠️ ข้าม processes บน Windows เพื่อลดภาระ CPU (enumerating processes เป็นการเรียกแพงมาก)
            let processes = { all: 0, running: 0, blocked: 0 };
            if (os.platform() === 'linux') {
                processes = await si.processes().catch(() => ({ all: 0, running: 0, blocked: 0 }));
            }
            
            const osInfo = await si.osInfo();
            const cpuInfo = await si.cpu();
            
            // 🛠️ เรียก si.services() เฉพาะบน Linux เท่านั้น เพื่อป้องกัน CPU 100% บน Windows
            let servicesData = [];
            if (os.platform() === 'linux') {
                servicesData = await si.services('nginx, php-fpm, mariadb, node').catch(() => []);
            }

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
            if (os.platform() === 'linux' && servicesData && servicesData.length > 0) {
                servicesData.forEach(service => {
                    // 🛠️ บันทึก Service ที่เคยทำงาน (เพื่อเช็คว่าเคยเปิดมาหรือไม่)
                    if (service.running) {
                        initiallyRunningServices.add(service.name);
                    }

                    // 🛠️ แจ้งเตือนเฉพาะ Service ที่เคยทำงานมาก่อนเท่านั้น
                    if (!service.running && initiallyRunningServices.has(service.name)) {
                        const lastAlert = serviceAlertStatus[service.name] || 0;
                        if (now - lastAlert > ALERT_COOLDOWN_MS) {
                            sendTelegramAlert(`❌ [ฉุกเฉิน] Service ร่วง!\nระบบ ${service.name.toUpperCase()} หยุดทำงาน กรุณาตรวจสอบด่วนครับ`);
                            serviceAlertStatus[service.name] = now;
                        }
                    } else if (service.running) {
                        if (serviceAlertStatus[service.name]) {
                            sendTelegramAlert(`✅ [กลับสู่สภาวะปกติ]\nระบบ ${service.name.toUpperCase()} กลับมาทำงานปกติแล้วครับ`);
                            delete serviceAlertStatus[service.name];
                        }
                    }
                });
            }

            // 3. ส่งข้อมูลไปที่หน้าเว็บ
            const serverData = {
                cpu: cpuLoad.currentLoad.toFixed(2),
                cpuTemp: cpuTemp.main || 0,
                ram: usedMemPercent,
                ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(2),
                ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(2),
                ramFree: (mem.available / 1024 / 1024 / 1024).toFixed(2),
                disk: diskUsedPercent,
                diskTotal: disk && disk.length > 0 ? (disk[0].size / 1024 / 1024 / 1024).toFixed(2) : 0,
                diskUsed: disk && disk.length > 0 ? (disk[0].used / 1024 / 1024 / 1024).toFixed(2) : 0,
                diskRead: (diskIO.rIO / 1024 / 1024).toFixed(2),
                diskWrite: (diskIO.wIO / 1024 / 1024).toFixed(2),
                netRx: rxSec,
                netTx: txSec,
                uptime: uptimeHours,
                loadAvg1: loadAvg[0] || 0,
                loadAvg5: loadAvg[1] || 0,
                loadAvg15: loadAvg[2] || 0,
                processCount: processes.all || 0,
                processRunning: processes.running || 0,
                osInfo: osInfo,
                cpuInfo: cpuInfo,
                services: servicesData
            };
            socket.emit('server-data', serverData);

            // 4. อัปเดตข้อมูลลง Database
            const sqlCurrent = `
                INSERT INTO current_status (server_name, cpu_percent, ram_percent, disk_percent, net_rx, net_tx, uptime_hrs) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                cpu_percent=VALUES(cpu_percent), ram_percent=VALUES(ram_percent), disk_percent=VALUES(disk_percent),
                net_rx=VALUES(net_rx), net_tx=VALUES(net_tx), uptime_hrs=VALUES(uptime_hrs)
            `;
            await dbPool.execute(sqlCurrent, ['Main-Server', serverData.cpu, serverData.ram, serverData.disk, serverData.netRx, serverData.netTx, serverData.uptime]);

            // 🌟 บันทึกประวัติลงตาราง history_log
            const sqlHistory = `INSERT INTO history_log (server_name, cpu_percent, ram_percent) VALUES (?, ?, ?)`;
            await dbPool.execute(sqlHistory, ['Main-Server', serverData.cpu, serverData.ram]);

        } catch (error) {
            console.error('เกิดข้อผิดพลาด:', error);
        }
    }, 10000);

    socket.on('disconnect', () => {
        clearInterval(interval);
    });
});

// ... โค้ดส่วนล่าง (server.listen) เหมือนเดิม ...

const PORT = parseInt(process.env.PORT) || 3000;
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