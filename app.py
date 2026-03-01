from flask import Flask, render_template, request, jsonify
import sqlite3
import datetime

app = Flask(__name__)

# create database
def init_db():
    conn = sqlite3.connect("database.db")
    conn.execute("CREATE TABLE IF NOT EXISTS logs(student TEXT, violation TEXT, time TEXT)")
    conn.close()

init_db()

# student exam page
@app.route("/")
def exam():
    return render_template("exam.html")

# receive violation
@app.route("/log", methods=["POST"])
def log():
    data = request.json
    student = data["student"]
    violation = data["violation"]
    time = datetime.datetime.now().strftime("%H:%M:%S")

    conn = sqlite3.connect("database.db")
    conn.execute("INSERT INTO logs VALUES (?, ?, ?)", (student, violation, time))
    conn.commit()
    conn.close()

    return jsonify({"status": "logged"})

# admin dashboard
@app.route("/dashboard")
@app.route("/dashboard")
def dashboard():

    conn = sqlite3.connect("database.db")

    logs = conn.execute("SELECT * FROM logs").fetchall()

    violation_count = conn.execute("SELECT COUNT(*) FROM logs").fetchone()[0]

    conn.close()

    trust_score = max(0, 100 - (violation_count * 10))

    return render_template(
        "dashboard.html",
        logs=logs,
        score=trust_score
    )

if __name__ == "__main__":
    app.run(debug=True)