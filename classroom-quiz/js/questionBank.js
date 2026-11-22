// Question-bank importer.
//
// Reads question-bank JSON files in this format (one lesson per file):
//
// {
//   "metadata": { "id": "grade-6-lesson-1", "grade": 6, "subject": "...",
//                 "lesson": 1, "title": "...", "version": 1 },
//   "questions": [
//     { "id": "L1-Q001", "type": "mcq", "question": "...", "marks": 2,
//       "options": [{ "id": "A", "text": "..." }, ...],
//       "correctOptionId": "B", "explanation": "..." },
//     { "id": "L1-Q002", "type": "true_false", ... same as mcq ... },
//     { "id": "L1-Q003", "type": "short_answer", "question": "...", "marks": 2,
//       "acceptedAnswers": ["Central Processing Unit"],
//       "caseSensitive": false, "trimWhitespace": true, "explanation": "..." }
//   ]
// }
//
// A file may also hold several lessons:
//   { "title": "...", "lessons": [ { "lessonId": "lesson-1", "title": "...",
//       "questions": [ { "id": "q01", "type": "multiple_choice", "question": "...",
//         "marks": 1, "options": [{ "id": "a", "text": "..." }, ...],
//         "correctAnswer": "a" } ] } ] }
// or an array of lesson objects, or { "quizzes": [...] }.
// Each lesson becomes its own quiz. Lessons with no questions are skipped.
//
// Each lesson becomes two Firestore documents:
//   quizzes/{metadata.id}     public: question text + options, NO answers
//   answerKeys/{metadata.id}  teacher only: correct answers + explanations
//
// The JSON is parsed in the teacher's browser (dashboard -> Question banks),
// never on student pages, so the file with answers never reaches students.

export const QUESTION_TYPES = ["mcq", "true_false", "short_answer"];
const TYPE_ALIASES = {
  multiple_choice: "mcq", "multiple-choice": "mcq", multiplechoice: "mcq", choice: "mcq",
  truefalse: "true_false", "true-false": "true_false", boolean: "true_false",
  short: "short_answer", "short-answer": "short_answer", text: "short_answer"
};
export const SHORT_ANSWER_MAX_LENGTH = 200;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

/** Turns any title into a safe document id. */
export function slugify(value) {
  return str(value).toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** Finds the lesson objects in the parsed file. */
function locateLessons(data) {
  if (Array.isArray(data)) return data;
  if (isObject(data) && Array.isArray(data.quizzes)) return data.quizzes;
  if (isObject(data) && Array.isArray(data.lessons)) return data.lessons;
  if (isObject(data)) return [data];
  return [];
}

function parseQuestion(q, index, lessonLabel, errors, warnings) {
  const label = `${lessonLabel}, question ${index + 1}${isObject(q) && q.id ? ` (${q.id})` : ""}`;
  if (!isObject(q)) { errors.push(`${label}: is not a question object.`); return null; }

  const id = str(q.id);
  if (!id) { errors.push(`${label}: "id" is missing.`); return null; }
  if (!ID_PATTERN.test(id)) { errors.push(`${label}: "id" may only contain letters, numbers, dots, dashes and underscores.`); return null; }

  const text = str(q.question);
  if (!text) { errors.push(`${label}: "question" text is missing.`); return null; }

  let type = str(q.type).toLowerCase() || (Array.isArray(q.acceptedAnswers) ? "short_answer" : "mcq");
  type = TYPE_ALIASES[type] || type;
  if (!QUESTION_TYPES.includes(type)) {
    errors.push(`${label}: unknown type "${q.type}". Use mcq, true_false or short_answer.`);
    return null;
  }

  let marks = Number(q.marks);
  if (q.marks === undefined) marks = 1;
  if (!Number.isFinite(marks) || marks <= 0) { errors.push(`${label}: "marks" must be a positive number.`); return null; }

  const base = {
    id, type, text, marks,
    explanation: str(q.explanation),
    image: typeof q.image === "string" ? q.image.trim() : ""
  };

  if (type === "short_answer") {
    const accepted = (Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [q.acceptedAnswers])
      .map(str).filter(Boolean);
    if (!accepted.length) { errors.push(`${label}: "acceptedAnswers" needs at least one answer.`); return null; }
    return {
      ...base,
      acceptedAnswers: accepted,
      caseSensitive: q.caseSensitive === true,
      trimWhitespace: q.trimWhitespace !== false
    };
  }

  // mcq / true_false
  let options = Array.isArray(q.options) ? q.options : null;
  if (!options && type === "true_false") options = [{ id: "A", text: "True" }, { id: "B", text: "False" }];
  if (!options || options.length < 2) { errors.push(`${label}: needs at least two "options".`); return null; }
  const parsedOptions = [];
  for (const [k, opt] of options.entries()) {
    const optId = str(isObject(opt) ? opt.id : String.fromCharCode(65 + k));
    const optText = str(isObject(opt) ? opt.text : opt);
    if (!optId || !optText) { errors.push(`${label}: option ${k + 1} needs an "id" and "text".`); return null; }
    if (!ID_PATTERN.test(optId)) { errors.push(`${label}: option id "${optId}" has invalid characters.`); return null; }
    parsedOptions.push({ id: optId, text: optText });
  }
  if (new Set(parsedOptions.map((o) => o.id)).size !== parsedOptions.length) {
    errors.push(`${label}: two options have the same id.`); return null;
  }
  // "correctOptionId" (option id) or "correctAnswer" (option id, or the option's exact text).
  const answerField = q.correctOptionId !== undefined ? "correctOptionId" : "correctAnswer";
  const correct = str(q[answerField]);
  if (!correct) { errors.push(`${label}: the correct answer is missing (use "correctOptionId" or "correctAnswer").`); return null; }
  const match = parsedOptions.find((o) => o.id === correct)
    || parsedOptions.find((o) => o.id.toLowerCase() === correct.toLowerCase())
    || parsedOptions.find((o) => o.text.toLowerCase() === correct.toLowerCase());
  if (!match) { errors.push(`${label}: "${answerField}" "${correct}" does not match any option.`); return null; }
  return { ...base, options: parsedOptions, correctOptionId: match.id };
}

/**
 * Parses question-bank JSON (string or already-parsed object).
 * Returns { quizzes: [...], errors: [...], warnings: [...] }.
 * A lesson with any invalid question is rejected as a whole, so a quiz is
 * never published with questions silently missing.
 */
export function parseQuestionBank(input, sourceName = "") {
  const errors = [];
  const warnings = [];
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); }
    catch (e) { return { quizzes: [], errors: [`${sourceName || "The file"} is not valid JSON (${e.message}).`], warnings }; }
  }

  const lessons = locateLessons(data);
  if (!lessons.length) {
    return { quizzes: [], errors: [`${sourceName || "The file"} does not contain any lessons.`], warnings };
  }

  const quizzes = [];
  const seenQuizIds = new Set();
  lessons.forEach((lesson, li) => {
    const meta = isObject(lesson?.metadata) ? lesson.metadata : (isObject(lesson) ? lesson : {});
    const title = str(meta.title) || `Lesson ${str(meta.lesson) || li + 1}`;
    const lessonLabel = `"${title}"`;
    let quizId = str(meta.id) || str(meta.lessonId) || slugify(title);
    if (!ID_PATTERN.test(quizId)) {
      const fixed = slugify(quizId);
      warnings.push(`${lessonLabel}: id "${quizId}" was changed to "${fixed}".`);
      quizId = fixed;
    }
    if (!quizId) { errors.push(`${lessonLabel}: "metadata.id" is missing.`); return; }
    if (seenQuizIds.has(quizId)) { errors.push(`${lessonLabel}: id "${quizId}" is used by two lessons in this file.`); return; }
    seenQuizIds.add(quizId);

    const rawQuestions = Array.isArray(lesson?.questions) ? lesson.questions : null;
    if (!rawQuestions || !rawQuestions.length) {
      // Not an error: a lesson may be listed before its questions are written.
      warnings.push(`${lessonLabel} has no questions yet, so it was skipped. Import it again once questions are added.`);
      return;
    }

    const before = errors.length;
    const questions = [];
    const seenQ = new Set();
    rawQuestions.forEach((q, i) => {
      const parsed = parseQuestion(q, i, lessonLabel, errors, warnings);
      if (!parsed) return;
      if (seenQ.has(parsed.id)) { errors.push(`${lessonLabel}: question id "${parsed.id}" is used twice.`); return; }
      seenQ.add(parsed.id);
      questions.push(parsed);
    });
    if (errors.length > before) {
      errors.push(`${lessonLabel} was not imported. Fix the problems above and try again.`);
      return;
    }

    const passRaw = Number(meta.passPercent);
    quizzes.push({
      quizId,
      title,
      subject: str(meta.subject),
      lesson: str(meta.lesson),
      grade: str(meta.grade),
      version: str(meta.version) || "1",
      description: str(meta.description),
      passPercent: Number.isFinite(passRaw) && passRaw > 0 && passRaw <= 100 ? passRaw : null,
      questions,
      source: sourceName
    });
  });

  return { quizzes, errors, warnings };
}

/** Public document: everything students need, with no answers. */
export function toPublicQuiz(quiz) {
  return {
    title: quiz.title,
    subject: quiz.subject,
    lesson: quiz.lesson,
    grade: quiz.grade,
    description: quiz.description,
    version: quiz.version,
    questionCount: quiz.questions.length,
    totalMarks: quiz.questions.reduce((s, q) => s + q.marks, 0),
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      marks: q.marks,
      ...(q.options ? { options: q.options.map((o) => ({ id: o.id, text: o.text })) } : {}),
      ...(q.image ? { image: q.image } : {})
    }))
  };
}

/** Teacher-only document: correct answers, explanations and grading options. */
export function toAnswerKey(quiz) {
  return {
    title: quiz.title,
    version: quiz.version,
    passPercent: quiz.passPercent,
    questions: quiz.questions.map((q) => (q.type === "short_answer"
      ? {
          id: q.id, type: q.type, text: q.text, marks: q.marks, explanation: q.explanation,
          acceptedAnswers: q.acceptedAnswers, caseSensitive: q.caseSensitive, trimWhitespace: q.trimWhitespace
        }
      : {
          id: q.id, type: q.type, text: q.text, marks: q.marks, explanation: q.explanation,
          options: q.options, correctOptionId: q.correctOptionId
        }))
  };
}
