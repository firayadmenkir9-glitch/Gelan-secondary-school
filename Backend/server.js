require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());


// DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});


// JWT
const JWT_SECRET =
  process.env.JWT_SECRET || "CHANGE_THIS_SECRET";


// TEST SERVER
app.get("/", (req, res) => {

  res.json({
    message: "Gelan Secondary School Backend is running"
  });

});


// AUTHENTICATION MIDDLEWARE
function authenticate(req, res, next) {

  const header = req.headers.authorization;

  if (!header) {

    return res.status(401).json({
      message: "Authentication required"
    });

  }

  const token = header.split(" ")[1];

  try {

    const decoded =
      jwt.verify(token, JWT_SECRET);

    req.student = decoded;

    next();

  } catch (error) {

    return res.status(401).json({
      message: "Invalid or expired token"
    });

  }

}


// LOGIN
app.post("/api/login", async (req, res) => {

  const { studentId, password } = req.body;

  if (!studentId || !password) {

    return res.status(400).json({
      message: "Student ID and password are required"
    });

  }

  try {

    const result = await pool.query(
      `SELECT id, student_id, name, password_hash, grade, section
       FROM students
       WHERE student_id = $1`,
      [studentId]
    );

    if (result.rows.length === 0) {

      return res.status(401).json({
        message: "Invalid Student ID or password"
      });

    }

    const student = result.rows[0];

    const valid =
      await bcrypt.compare(
        password,
        student.password_hash
      );

    if (!valid) {

      return res.status(401).json({
        message: "Invalid Student ID or password"
      });

    }

    const token =
      jwt.sign(
        {
          id: student.id,
          studentId: student.student_id
        },
        JWT_SECRET,
        {
          expiresIn: "7d"
        }
      );

    res.json({

      message: "Login successful",

      token,

      student: {
        id: student.id,
        studentId: student.student_id,
        name: student.name,
        grade: student.grade,
        section: student.section
      }

    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      message: "Server error"
    });

  }

});


// GET SUBJECTS
app.get(
  "/api/subjects",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `SELECT id, name
           FROM subjects
           ORDER BY name`
        );

      res.json(result.rows);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        message: "Failed to load subjects"
      });

    }

  }
);


// GET EXAMS FOR SUBJECT
app.get(
  "/api/subjects/:subjectId/exams",
  authenticate,
  async (req, res) => {

    const { subjectId } = req.params;

    try {

      const result =
        await pool.query(
          `SELECT id, title, exam_type, date
           FROM exams
           WHERE subject_id = $1
           ORDER BY date DESC`,
          [subjectId]
        );

      res.json(result.rows);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        message: "Failed to load exams"
      });

    }

  }
);


// GET SINGLE EXAM
app.get(
  "/api/exams/:examId",
  authenticate,
  async (req, res) => {

    const { examId } = req.params;

    try {

      const examResult =
        await pool.query(
          `SELECT id, title, exam_type, subject_id
           FROM exams
           WHERE id = $1`,
          [examId]
        );

      if (examResult.rows.length === 0) {

        return res.status(404).json({
          message: "Exam not found"
        });

      }

      const questionsResult =
        await pool.query(
          `SELECT
             id,
             question,
             option_a,
             option_b,
             option_c,
             option_d
           FROM questions
           WHERE exam_id = $1
           ORDER BY id`,
          [examId]
        );

      res.json({

        ...examResult.rows[0],

        questions:
          questionsResult.rows

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        message: "Failed to load exam"
      });

    }

  }
);


// SUBMIT EXAM
app.post(
  "/api/exams/:examId/submit",
  authenticate,
  async (req, res) => {

    const { examId } = req.params;

    const { answers } = req.body;

    if (!answers) {

      return res.status(400).json({
        message: "Answers are required"
      });

    }

    try {

      const result =
        await pool.query(
          `SELECT id, correct_answer
           FROM questions
           WHERE exam_id = $1`,
          [examId]
        );

      const questions =
        result.rows;

      let score = 0;

      questions.forEach(question => {

        const studentAnswer =
          answers[question.id];

        if (
          studentAnswer &&
          studentAnswer.toUpperCase() ===
          question.correct_answer.toUpperCase()
        ) {

          score++;

        }

      });

      const total =
        questions.length;

      const percentage =
        total === 0
          ? 0
          : Number(
              ((score / total) * 100)
              .toFixed(2)
            );


      let grade;

      if (percentage >= 90) {
        grade = "A+";
      } else if (percentage >= 80) {
        grade = "A";
      } else if (percentage >= 70) {
        grade = "B";
      } else if (percentage >= 60) {
        grade = "C";
      } else if (percentage >= 50) {
        grade = "D";
      } else {
        grade = "F";
      }


      // SAVE RESULT
      await pool.query(
        `INSERT INTO results
         (student_id, exam_id, score, total, percentage, grade)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.student.id,
          examId,
          score,
          total,
          percentage,
          grade
        ]
      );


      res.json({

        message: "Exam submitted successfully",

        score,

        total,

        percentage,

        grade

      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        message: "Failed to submit exam"
      });

    }

  }
);


// STUDENT RESULTS
app.get(
  "/api/results",
  authenticate,
  async (req, res) => {

    try {

      const result =
        await pool.query(
          `SELECT
             results.id,
             exams.title,
             results.score,
             results.total,
             results.percentage,
             results.grade,
             results.submitted_at
           FROM results
           JOIN exams
             ON results.exam_id = exams.id
           WHERE results.student_id = $1
           ORDER BY results.submitted_at DESC`,
          [req.student.id]
        );

      res.json(result.rows);

    } catch (error) {

      console.error(error);

      res.status(500).json({
        message: "Failed to load results"
      });

    }

  }
);


// SERVER
const PORT =
  process.env.PORT || 5000;

app.listen(PORT, () => {

  console.log(
    `Gelan Secondary School API running on port ${PORT}`
  );

});
