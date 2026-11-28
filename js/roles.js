// Who is signed in to the dashboard and what they may do.
//
// The profile comes from teachers/{authUid}. These helpers only decide what
// the screens show; firestore.rules enforce the same limits on every read
// and write, so changing this code in the browser gives no extra access.

export const session = {
  uid: "",
  role: "",          // "admin" | "teacher"
  teacherId: "",     // stable id (survives a password reset)
  name: "",
  username: "",
  email: "",
  classes: {}        // { "6": ["A", "B"] } (teachers only)
};

export function setSession(profile) {
  Object.assign(session, {
    uid: profile.uid,
    role: profile.role,
    teacherId: profile.teacherId || profile.uid,
    name: profile.name || "",
    username: profile.username || "",
    email: profile.email || "",
    classes: cleanClasses(profile.classes)
  });
}

export const isAdmin = () => session.role === "admin";
export const isTeacher = () => session.role === "teacher";
export const displayName = () => session.name || session.username || session.email || "Admin";

/** { "6": ["A","B"] } with empty grades removed and sections de-duplicated. */
export function cleanClasses(classes) {
  const out = {};
  if (!classes || typeof classes !== "object") return out;
  Object.entries(classes).forEach(([g, list]) => {
    const secs = [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))];
    if (secs.length) out[String(g)] = secs;
  });
  return out;
}

/** True when the user may see records of this grade + section. */
export function canSeeClass(grade, section) {
  if (isAdmin()) return true;
  return (session.classes[String(grade)] || []).includes(String(section));
}

/** Grades the user works with (all grades from settings for the Admin). */
export function myGrades(settings) {
  if (isAdmin()) return settings.grades;
  const mine = Object.keys(session.classes);
  // Keep the School settings order; grades no longer in settings go last.
  return [...settings.grades.filter((g) => mine.includes(g)), ...mine.filter((g) => !settings.grades.includes(g))];
}

/** Sections of one grade the user works with. */
export function mySections(settings, grade) {
  const all = (settings.sectionsByGrade && settings.sectionsByGrade[grade]) || [];
  if (isAdmin()) return all;
  const mine = session.classes[String(grade)] || [];
  return [...all.filter((s) => mine.includes(s)), ...mine.filter((s) => !all.includes(s))];
}

/**
 * Every (grade, section) pair a scope covers for this user. The Admin can
 * query any scope directly (returns null = "no split needed"); a teacher's
 * queries must name one of their grades AND sections, so a wider scope is
 * split into one query per class.
 */
export function classPairs(scope = {}) {
  if (isAdmin()) return null;
  const pairs = [];
  Object.entries(session.classes).forEach(([g, secs]) => {
    if (scope.grade && String(scope.grade) !== g) return;
    secs.forEach((s) => {
      if (scope.section && String(scope.section) !== s) return;
      pairs.push({ grade: g, section: s });
    });
  });
  return pairs;
}

/**
 * Display text for the sections chosen in one grade. When every section the
 * grade has in School settings is chosen it says "All sections" (so a long
 * list never crowds the screen). The current settings are used each time, so
 * the wording follows sections being added, removed or renamed. Only the
 * text changes: the stored list stays exactly as it is.
 *   secs empty -> emptyText (quizzes: "All sections"; teachers: "None")
 */
export function sectionsText(settings, grade, secs, { emptyText = "All sections", prefix = "" } = {}) {
  const chosen = [...new Set((Array.isArray(secs) ? secs : []).map(String).filter(Boolean))];
  if (!chosen.length) return emptyText;
  const all = (settings?.sectionsByGrade && settings.sectionsByGrade[String(grade)]) || [];
  if (all.length && all.every((x) => chosen.includes(String(x)))) return "All sections";
  return `${prefix}${chosen.join(", ")}`;
}

/** "Grade 6: A, B · Grade 7: All sections" */
export function classesLabel(classes, settings = null) {
  const entries = Object.entries(cleanClasses(classes));
  if (!entries.length) return "No classes assigned";
  return entries
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([g, secs]) => `Grade ${g}: ${settings ? sectionsText(settings, g, secs) : secs.join(", ")}`).join(" · ");
}

/** A quiz belongs to the user (teachers), or any quiz (Admin). */
export function ownsQuiz(quiz) {
  if (isAdmin()) return true;
  return !!quiz && quiz.ownerId === session.teacherId;
}

/** Quizzes whose results a teacher may meet: their own and those for their classes. */
export function quizForMyClasses(quiz) {
  if (isAdmin() || !quiz) return true;
  if (quiz.ownerId === session.teacherId) return true;
  const g = String(quiz.grade || "");
  if (!g) return true;
  const mine = session.classes[g];
  if (!mine) return false;
  const secs = Array.isArray(quiz.sections) ? quiz.sections : [];
  return !secs.length || secs.some((s) => mine.includes(s));
}

export const NO_PERMISSION = "You don't have permission to perform this operation. Please contact the Admin.";
