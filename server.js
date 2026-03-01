const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Store active data
const students = new Map();      // studentId -> student info
const violations = new Map();    // studentId -> array of violations

// Store completed exams data
const completedExams = new Map(); // examCode -> array of student final results

function generateExamCode() {
  return 'EXAM-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function calculateTrustScore(violationList) {
  if (!violationList || violationList.length === 0) return 100;
  const weights = {
    'tab_switch': 15,
    'window_resize': 10,
    'keyboard_shortcut': 10,
    'idle': 5,
    'right_click': 5,
    'fullscreen_exit': 15,
    'devtools': 25,
    'copy_attempt': 20,
    'window_blur': 5
  };
  let total = 0;
  violationList.forEach(v => total += weights[v.type] || 10);
  return Math.max(0, 100 - total);
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-exam', (data) => {
    const { studentName, examCode } = data;
    console.log(`${studentName} joining exam ${examCode} with socket ${socket.id}`);

    students.set(socket.id, {
      id: socket.id,
      name: studentName,
      examCode,
      joinTime: new Date(),
      lastActive: new Date()
    });

    if (!violations.has(socket.id)) {
      violations.set(socket.id, []);
    }

    io.emit('student-joined', {
      id: socket.id,
      name: studentName,
      examCode,
      trustScore: 100,
      violationCount: 0
    });
  });

  socket.on('leave-exam', (data) => {
    console.log(`Student ${socket.id} leaving exam ${data.examCode}`);
    const student = students.get(socket.id);
    if (student) {
      io.emit('student-left', { id: socket.id, name: student.name });
      students.delete(socket.id);
      violations.delete(socket.id);
    }
  });

  socket.on('violation', (data) => {
    const student = students.get(socket.id);
    if (!student) {
      console.log(`Ignoring violation from unknown student ${socket.id}`);
      return;
    }

    const { type, details, duration, examCode } = data;
    let studentViolations = violations.get(socket.id) || [];

    const violation = {
      id: Date.now(),
      type,
      details,
      duration: duration || null,
      time: Date.now()
    };
    studentViolations.push(violation);
    violations.set(socket.id, studentViolations);

    const trustScore = calculateTrustScore(studentViolations);

    io.emit('new-violation', {
      studentId: socket.id,
      studentName: student.name,
      violation,
      trustScore,
      violationCount: studentViolations.length,
      allViolations: studentViolations
    });
  });

  socket.on('exam-completed', (data) => {
    console.log(`Exam completed for ${data.studentName} with score ${data.score}/10 and ${data.violations} violations`);

    // Store in completedExams
    const examCode = data.examCode;
    if (!completedExams.has(examCode)) {
      completedExams.set(examCode, []);
    }
    completedExams.get(examCode).push({
      studentName: data.studentName,
      studentId: data.studentId,
      score: data.score,
      totalQuestions: data.totalQuestions,
      trustScore: data.trustScore,
      violations: data.violations,
      violationDetails: data.violationDetails,
      completedAt: new Date()
    });

    // Broadcast to all admins so they can update the last student display
    io.emit('exam-completed', {
      studentName: data.studentName,
      examCode: data.examCode,
      trustScore: data.trustScore,
      violations: data.violations,
      violationDetails: data.violationDetails
    });

    // Remove from active students
    const student = students.get(data.studentId);
    if (student) {
      io.emit('student-left', { id: data.studentId, name: student.name });
      students.delete(data.studentId);
      violations.delete(data.studentId);
    }
  });

  socket.on('get-student-details', (studentId) => {
    const v = violations.get(studentId) || [];
    const student = students.get(studentId);
    socket.emit('student-details', {
      studentId,
      studentName: student?.name || 'Unknown',
      violations: v,
      trustScore: calculateTrustScore(v)
    });
  });

  socket.on('admin-join', () => {
    console.log('Admin joined');

    // Send active students
    const studentList = [];
    students.forEach((s, id) => {
      const v = violations.get(id) || [];
      studentList.push({
        id,
        name: s.name,
        examCode: s.examCode,
        joinTime: s.joinTime,
        lastActive: s.lastActive,
        violationCount: v.length,
        trustScore: calculateTrustScore(v)
      });
    });
    socket.emit('initial-data', studentList);

    // Send all active violations
    const allV = [];
    violations.forEach((vList, sid) => {
      const s = students.get(sid);
      vList.forEach(v => allV.push({ ...v, studentId: sid, studentName: s?.name || 'Unknown' }));
    });
    allV.sort((a, b) => b.time - a.time);
    socket.emit('all-violations', allV);

    // Send completed exams
    const completedList = [];
    completedExams.forEach((students, examCode) => {
      completedList.push({
        examCode,
        students: students.map(s => ({
          studentName: s.studentName,
          trustScore: s.trustScore,
          violations: s.violations,
          violationDetails: s.violationDetails,
          score: s.score,
          completedAt: s.completedAt
        }))
      });
    });
    socket.emit('completed-exams', completedList);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const student = students.get(socket.id);
    if (student) {
      io.emit('student-left', { id: socket.id, name: student.name });
      students.delete(socket.id);
    }
  });
});

app.post('/api/create-exam', (req, res) => {
  const examCode = generateExamCode();
  res.json({ examCode });
});

app.get('/api/completed-exams', (req, res) => {
  const summary = [];
  completedExams.forEach((students, examCode) => {
    const avgTrust = students.reduce((sum, s) => sum + s.trustScore, 0) / students.length;
    summary.push({
      examCode,
      studentCount: students.length,
      avgTrust: Math.round(avgTrust),
      students: students.map(s => ({
        studentName: s.studentName,
        trustScore: s.trustScore,
        score: s.score
      }))
    });
  });
  res.json(summary);
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`📝 Student exam: http://localhost:${PORT}`);
  console.log(`📊 Admin dashboard: http://localhost:${PORT}/dashboard.html`);
});