// Question-bank importer (runs only in the teacher dashboard).
//
// Supported JSON (schema 2.0, recommended):
//   { "schemaVersion": "2.0", "grade": 7, "title": "...", "subject": "...",
//     "lessons": [ { "lessonId": "lesson-1", "title": "...",
//       "questions": [ { "id": "q01", "type": "multiple_choice", "question": "...",
//         "marks": 1, "options": [{ "id": "a", "text": "..." }, ...],
//         "correctAnswer": "a", "explanation": "..." } ] } ] }
// Also accepted (older files keep working):
//   - the same without "grade" (the teacher picks the grade when importing)
//   - { "metadata": { "id", "grade", "title", ... }, "questions": [...] }
//     with "correctOptionId" (schema 1)
//   - an array of lesson objects, or { "quizzes": [...] }
// Question types: multiple_choice / mcq, true_false, short_answer
// (short answers use "acceptedAnswers", "caseSensitive", "trimWhitespace").
//
// The file is parsed into LESSONS. The teacher then turns lessons into
// QUIZZES: one quiz per lesson, or several lessons merged into one quiz.
// Each quiz is stored as three documents:
//   quizzes/{quizId}      public list information (title, grade, counts)
//   quizContent/{quizId}  public questions and options, NO answers
//   answerKeys/{quizId}   correct answers and explanations (teacher only)
// The JSON never leaves the teacher's browser, so students never receive it.

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
 * Parses question-bank JSON (string or object) into lessons.
 * Returns { lessons: [...], errors: [...], warnings: [...] }.
 * A lesson with any invalid question is rejected as a whole, so a quiz is
 * never published with questions silently missing. Lessons without questions
 * are skipped with a warning.
 */
export function parseQuestionBank(input, sourceName = "") {
  const errors = [];
  const warnings = [];
  const fileLabel = sourceName || "The file";
  let data = input;
  if (typeof input === "string") {
    try { data = JSON.parse(input); }
    catch (e) { return { lessons: [], errors: [`${fileLabel} is not valid JSON (${e.message}).`], warnings }; }
  }
  const rawLessons = locateLessons(data);
  if (!rawLessons.length) return { lessons: [], errors: [`${fileLabel} does not contain any lessons.`], warnings };

  const file = isObject(data) ? data : {};
  const fileGrade = str(file.grade ?? file.metadata?.grade);
  const schemaVersion = str(file.schemaVersion) || (file.metadata ? "1" : "");
  if (schemaVersion && !/^[12](\.\d+)?$/.test(schemaVersion)) {
    warnings.push(`${fileLabel}: schemaVersion "${schemaVersion}" is newer than this app knows; importing it as 2.0.`);
  }

  const lessons = [];
  const seenIds = new Set();
  rawLessons.forEach((lesson, li) => {
    const meta = isObject(lesson?.metadata) ? lesson.metadata : (isObject(lesson) ? lesson : {});
    const title = str(meta.title) || `Lesson ${str(meta.lesson) || li + 1}`;
    const lessonLabel = `"${title}"`;
    let lessonId = str(meta.lessonId) || str(meta.id) || slugify(title);
    if (!ID_PATTERN.test(lessonId)) {
      const fixed = slugify(lessonId);
      warnings.push(`${lessonLabel}: id "${lessonId}" was changed to "${fixed}".`);
      lessonId = fixed;
    }
    if (!lessonId) { errors.push(`${lessonLabel}: "lessonId" is missing.`); return; }
    if (seenIds.has(lessonId)) { errors.push(`${lessonLabel}: lesson id "${lessonId}" is used twice in ${fileLabel}.`); return; }
    seenIds.add(lessonId);

    const rawQuestions = Array.isArray(lesson?.questions) ? lesson.questions : null;
    if (!rawQuestions || !rawQuestions.length) {
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
      questions.push({ ...parsed, lessonId, lessonTitle: title });
    });
    if (errors.length > before) {
      errors.push(`${lessonLabel} was not imported. Fix the problems above and try again.`);
      return;
    }
    const passRaw = Number(meta.passPercent ?? file.passPercent);
    lessons.push({
      key: `${sourceName}::${lessonId}`,
      lessonId,
      title,
      grade: str(meta.grade) || fileGrade,
      subject: str(meta.subject ?? file.subject),
      description: str(meta.description),
      version: str(meta.version ?? file.version) || "1",
      passPercent: Number.isFinite(passRaw) && passRaw > 0 && passRaw <= 100 ? passRaw : null,
      questions,
      source: sourceName,
      fileTitle: str(file.title)
    });
  });
  return { lessons, errors, warnings };
}

/** Proposed document id for a quiz: grade prefix + lesson id or title. */
export function proposeQuizId(grade, base) {
  const g = slugify(grade);
  return `${g ? `g${g}-` : ""}${slugify(base) || "quiz"}`.slice(0, 80);
}

/**
 * Builds one quiz from one or more lessons.
 *   merge=false: lessons.length must be 1; question ids stay as in the file.
 *   merge=true:  question ids become "<lessonId>-<questionId>" so they stay
 *                unique; lesson id and title are kept on every question.
 * Duplicate questions (same lesson+id, or identical text) are skipped.
 * Returns { quiz, warnings }.
 */
export function buildQuiz(lessons, { title, grade, merge = false } = {}) {
  const warnings = [];
  const questions = [];
  const seenKeys = new Set();
  const seenText = new Map();
  lessons.forEach((lesson) => {
    lesson.questions.forEach((q) => {
      const key = `${lesson.lessonId}/${q.id}`;
      if (seenKeys.has(key)) { warnings.push(`Skipped duplicate question ${q.id} from ${lesson.title}.`); return; }
      const textKey = q.text.toLowerCase().replace(/\s+/g, " ");
      if (merge && seenText.has(textKey)) {
        warnings.push(`Skipped "${q.text.slice(0, 60)}" from ${lesson.title}: the same question is already in ${seenText.get(textKey)}.`);
        return;
      }
      seenKeys.add(key);
      seenText.set(textKey, lesson.title);
      questions.push({ ...q, id: merge ? `${lesson.lessonId}-${q.id}`.slice(0, 80) : q.id, sourceQuestionId: q.id });
    });
  });
  const first = lessons[0];
  const passValues = lessons.map((l) => l.passPercent).filter(Boolean);
  const quizTitle = str(title) || (merge ? lessons.map((l) => l.title).join(" + ") : first.title);
  return {
    quiz: {
      quizId: merge ? proposeQuizId(grade, quizTitle) : proposeQuizId(grade, first.lessonId),
      title: quizTitle,
      grade: str(grade),
      subject: first.subject,
      description: merge ? `Merged from ${lessons.length} lessons` : first.description,
      version: first.version,
      passPercent: passValues.length ? Math.max(...passValues) : null,
      merged: !!merge && lessons.length > 1,
      lessons: lessons.map((l) => ({ lessonId: l.lessonId, title: l.title, questionCount: l.questions.length })),
      questions,
      source: [...new Set(lessons.map((l) => l.source))].join(", ")
    },
    warnings
  };
}

/** Public list document (quizzes/{id}): no questions, no answers. */
export function toQuizMeta(quiz) {
  return {
    title: quiz.title,
    grade: quiz.grade,
    subject: quiz.subject || "",
    description: quiz.description || "",
    version: quiz.version || "1",
    merged: !!quiz.merged,
    lessons: quiz.lessons || [],
    questionCount: quiz.questions.length,
    totalMarks: quiz.questions.reduce((s, q) => s + q.marks, 0),
    format: 2
  };
}

/** Public questions document (quizContent/{id}): no answers. */
export function toQuizContent(quiz) {
  return {
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      marks: q.marks,
      ...(q.options ? { options: q.options.map((o) => ({ id: o.id, text: o.text })) } : {}),
      ...(q.image ? { image: q.image } : {}),
      ...(q.lessonId ? { lessonId: q.lessonId, lessonTitle: q.lessonTitle } : {})
    }))
  };
}

/** Teacher-only document: correct answers, explanations and grading options. */
export function toAnswerKey(quiz) {
  return {
    title: quiz.title,
    version: quiz.version || "1",
    passPercent: quiz.passPercent ?? null,
    questions: quiz.questions.map((q) => {
      const base = {
        id: q.id, type: q.type, text: q.text, marks: q.marks, explanation: q.explanation || "",
        lessonId: q.lessonId || "", lessonTitle: q.lessonTitle || ""
      };
      return q.type === "short_answer"
        ? { ...base, acceptedAnswers: q.acceptedAnswers, caseSensitive: q.caseSensitive, trimWhitespace: q.trimWhitespace }
        : { ...base, options: q.options, correctOptionId: q.correctOptionId };
    })
  };
}
