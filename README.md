# Classroom Quiz

A quiz website for school students, plus a teacher dashboard for quizzes and
results. Built with plain **HTML, CSS and JavaScript** and **Firebase**
(Firestore, Authentication). It runs on any static host, such as **Netlify**
from a GitHub repository. It has no server code, no Cloud Functions and no
frameworks. Firebase is loaded from Google's CDN (SDK version 12.19.0, set in
`js/firebase.js`).

- **Students** type their name, roll number, grade and section once (it is remembered on the device), see the quizzes for their grade with a status for each, and take a quiz one question at a time. They need no account and no password.
- **The teacher** signs in to `dashboard.html` to add and manage quizzes, set grades and sections, grade and review submissions, print or save results as PDF, archive, back up and restore records, and see analysis.

**Version 2.0** (November 2026). What changed from version 1 is listed in
[section 10](#10-version-20-changes-and-upgrading), together with the upgrade steps.

---

## 1. Files

```text
classroom-quiz/
├── index.html            Student homepage: remembered details + quiz list for the student's grade
├── quiz.html             The quiz (one question at a time)
├── dashboard.html        Teacher dashboard (results, student history, analysis, quizzes, archive & backup, settings)
├── result.html           One student record (teacher only)
├── student.html          Forwards old history links to the dashboard's Student history tab
├── about.html            About page with the creator credit
├── css/
│   ├── style.css         Shared design + the print/PDF layout
│   ├── quiz.css          Student pages
│   └── dashboard.css     Teacher pages
├── js/
│   ├── firebase.js       Firebase config + initialisation (the only place the SDK is imported)
│   ├── auth.js           Anonymous student sign-in, teacher sign-in and check
│   ├── utilities.js      Shared helpers (settings, formatting, CSV, dialogs, storage)
│   ├── controls.js       Styled dropdowns, date pickers and file drop zones used on every page
│   ├── icons.js          Adds the matching Font Awesome icon to every button and menu item
│   ├── student.js        index.html: details form, quiz list and statuses
│   ├── quiz.js           quiz.html: navigation, saving, all-answers-required submit
│   ├── randomizer.js     Question and option shuffling
│   ├── antiCheat.js      Deterrents: hide on focus loss, copy/selection blocking, event log
│   ├── submission.js     Student Firestore reads/writes
│   ├── questionBank.js   Question-bank parser, quiz builder and merger (teacher only)
│   ├── grading.js        Marking logic (teacher only)
│   ├── dashboard.js      Dashboard sign-in and tabs
│   ├── teacherState.js   Quiz list + settings shared by the dashboard parts
│   ├── records.js        Teacher data access: queries, review, archive, restore, delete, import
│   ├── recordsView.js    Results and Archive tables (browse, filter, select, bulk actions)
│   ├── print.js          Print / PDF reports, grouped by student
│   ├── backup.js         Backup file (JSON), summary CSV and detailed CSV
│   ├── backupImport.js   Import a backup file with preview and duplicate check
│   ├── analytics.js      Calculations (Analysis tab, overall and average per student)
│   ├── analyticsView.js  Analysis tab
│   ├── quizAdmin.js      Quizzes tab: quiz tabs, sortable quiz table, add (separate or merged), edit, move, archive, delete
│   ├── quizCategories.js Quiz tabs: load, create, rename, delete (moving quizzes first), move quizzes
│   ├── tableSort.js      Column sorting shared by every dashboard table
│   ├── settingsAdmin.js  School settings tab: grades, sections per grade, students per section (highest roll number)
│   ├── result.js         result.html logic
│   └── studentHistory.js Student history tab: find students, one student's history, history prints
├── data/
│   └── sample-questions.json   Example of the older single-lesson format (blocked on Netlify)
├── firestore.rules       Security rules (the real protection)
├── firestore.indexes.json  Empty: no composite index is needed any more
├── 404.html              "Page not found" page
├── netlify.toml          Netlify settings: no build, blocked files, headers
├── .gitignore            Keeps real question banks and logs out of GitHub
├── firebase.json         Used only by the Firebase CLI to deploy rules (not for hosting)
├── .firebaserc           Points the Firebase CLI at project quiz-f4828
└── README.md
```

---

## 2. How it works

### Firestore collections

| Collection | Contents | Who can read | Who can write |
|---|---|---|---|
| `teachers/{uid}` | One document per authorised teacher | That teacher only | Nobody from the website (you add it in the console) |
| `settings/school` | Grades, sections of each grade, pass mark, students per section (`classSizes`, also the highest roll number) | Any signed-in user | Teacher |
| `settings/quizCategories` | The quiz tabs: `{ categories: [{ id, name }] }`, in display order | Any signed-in user (names only) | Teacher |
| `quizzes/{quizId}` | Quiz list entry: title, grade, question count, marks, lessons, open/closed, archived, `categoryId` (its tab). **No questions, no answers.** | Students: open quizzes only. Teacher: all | Teacher |
| `quizContent/{quizId}` | The questions and options. **No correct answers.** | Students: only while the quiz is open. Teacher: all | Teacher |
| `answerKeys/{quizId}` | Correct answers, accepted short answers, explanations, pass mark | **Teacher only** | Teacher |
| `attempts/{attemptId}` | Student details, question order, answers, warnings, timestamps, review status | The student who created it, and the teacher | The student (until submitted). The teacher can only set the review status, copy and delete. |
| `results/{attemptId}` | Calculated marks, per-question correctness, teacher overrides | **Teacher only** | Teacher |
| `archivedAttempts/{id}`, `archivedResults/{id}` | Archived records (moved here, not deleted) | **Teacher only** | Teacher |

Quizzes made with version 1 keep their questions inside `quizzes/{quizId}`.
They keep working; see section 10.

`attemptId` is `quizId_grade_section_roll`, for example
`g6-lesson-1_6_A_12`. Because the id is fixed, a student has **one current
attempt per quiz**, and the rules reject a second one. When the teacher allows
a retake, the old attempt is kept under a new id (`…~<time>`) and marked as a
**previous attempt**, so history is never lost. Results use the same id as
their attempt, so grading again overwrites the result instead of duplicating it.

### Student workflow

1. The student opens the site. Firebase signs them in **anonymously** in the background.
2. The first time, they enter name, roll number, grade and section. The section list shows only the sections of the chosen grade. The details are saved on the device (`localStorage`) and filled in next time. **Change details** edits them, and **Not you? Switch student** clears them on a shared computer.
3. The homepage lists the open quizzes **for the student's grade** (plus version 1 quizzes without a grade), each with its title, grade, number of questions and marks, lesson information for merged quizzes, and a status: *Not started*, *In progress (5/9)*, *Completed* or *Started on another device*. Quizzes are never combined unless the teacher merged them.
4. On **Start**, the quiz shuffles the question order and the option order of every question, and saves that order. Previous and Next never reshuffle, and neither does a refresh.
5. Every answer is saved on the device immediately, and to Firestore at most every 30 seconds, on the review screen and when leaving the page.
6. **Every question must be answered before submitting.** The review screen shows which questions are missing (in orange) and the message *"Please answer all 2 remaining questions before submitting."*, the Submit button stays disabled, and **Go to first unanswered** jumps back. The check is done again in JavaScript just before submitting, and the security rules refuse a submission that does not answer every question.
7. Submitting is **one write** that sets `status: "submitted"`. After that the rules lock the attempt. If the internet is down, the student sees a clear "NOT submitted yet" message, and the submit is retried automatically when the connection returns.

### Teacher workflow

1. Sign in. **Results** shows records by **Grade → Section → Quiz**, with counts on each grade and section.
2. **Grade all eligible** marks every submission that has no current result. Grading runs in the teacher's browser, because it needs the answer key.
3. Review each submission: **Accept**, **Decline** (kept, but left out of averages) or **Mark pending review**. The time and the teacher's email are recorded.
4. Print or save as PDF: one quiz report, results grouped by student, answer sheets, or student histories, each as one combined document.
5. Export a **summary CSV** (one row per attempt) or a **detailed CSV** (one row per question).
6. When an answer key or pass mark changes, results show **Needs regrading** until they are graded again. Overrides made by hand are kept.

Correct answers are **never sent to student browsers**. Students load only
`quizzes` and `quizContent`, which have no answers. This was checked in the
tests by capturing the student's network traffic (version 1 test) and by
reading every stored student-visible document (version 2 test).

### Screenshots and copying: what is and is not possible

A website **cannot reliably prevent screenshots** or photos of the screen. The
quiz page uses deterrents only:

| Protection | What it really does |
|---|---|
| Correct answers kept on the server, teacher only | **Real protection**, enforced by the security rules. |
| One attempt per student, all answers required, attempt locked after submit, grade check | **Real protection**, enforced by the security rules. |
| Question hidden ("Quiz paused") when the window loses focus, the tab is hidden, or a screenshot shortcut (Print Screen, Win+Shift+S, Cmd+Shift+3/4/5) is pressed | Deterrent. Shortcut detection happens *after* the key press on most systems, so some screenshots still succeed. It does not stop phone cameras or a second device. |
| Name and roll number watermark on the question | Deterrent: a leaked picture shows whose screen it was. |
| Text selection, copy, paste, right-click and printing blocked on the quiz | Deterrent. Easily bypassed by anyone who knows browser developer tools. |
| Keys locked from the moment the quiz starts until it is submitted: F1 to F12, Esc, Tab, Alt, Home/End, Ctrl/Cmd shortcuts (copy, paste, print, find, new tab, save, developer tools), and Backspace/Delete outside the answer box | Deterrent. Typing in a short-answer box still works (Backspace, Delete, Home/End, Ctrl+A/Z/Y). Before the quiz starts and after it is submitted, every key works normally. |
| Windows key and Alt+Tab blocked in fullscreen (Keyboard Lock API) | Works only in **Chrome and Edge on a computer**, only in fullscreen and only on HTTPS (Netlify is HTTPS). Esc must then be held down to leave fullscreen. Other browsers ignore it. |
| Keys a website can never block | Ctrl+Alt+Delete, Fn, and outside fullscreen the Windows key, Win+Shift+S and Alt+Tab go straight to the operating system. The question is hidden as soon as the window loses focus and the switch is recorded. |
| Tab switches, fullscreen exits, screenshot-key presses and blocked keys are counted and shown to the teacher | Information, not proof. Each kind of blocked key is logged at most once every 5 seconds. |

## 3. Setup (one time)

You need the Firebase project **quiz-f4828** (already configured in
`js/firebase.js`) and a Google account that owns it.

### 3.1 Turn on sign-in methods

Firebase console → **Build → Authentication → Sign-in method**:

1. Enable **Anonymous** (for students).
2. Enable **Email/Password** (for the teacher).

### 3.2 Create the Firestore database

Firebase console → **Build → Firestore Database**. If no database exists yet,
choose **Create database**, then **Production mode**, then a location near
your school.

### 3.3 Create the teacher account

1. **Authentication → Users → Add user.** Enter the teacher's email and a strong password. Passwords are never stored in the website code.
2. Copy the new user's **User UID**.
3. **Firestore Database → Data → Start collection.** Collection ID: `teachers`. Document ID: *paste the UID*. Add a field `email` (string) with the teacher's email, then **Save**.

That document is what makes an account a teacher. To add another teacher,
repeat these steps. To remove one, delete their `teachers` document.

Tip: if you sign in to the dashboard before creating the document, the
**Access denied** screen shows the UID you need to copy.

### 3.4 Publish the security rules

**Option A: Firebase CLI (recommended).** The CLI is a tool on your own
computer for deploying. It is not server code. You need Node.js installed.

```bash
npm install -g firebase-tools
firebase login
cd classroom-quiz
firebase deploy --only firestore:rules
```

**Option B: Firebase console.**

**Firestore Database → Rules**: replace everything with the contents of `firestore.rules`, then **Publish**.

No composite index is needed. (Version 1 used one on `attempts`; you can leave it or delete it.)

### 3.5 Put the website online (GitHub + Netlify)

The site is plain static files: there is no build step, and nothing needs
Firebase Hosting. All links between pages are relative, and file names are
written exactly as they are referenced (Netlify's servers are case-sensitive,
so do not rename `antiCheat.js` to `anticheat.js`, for example).

**1. Put the code on GitHub**

1. On GitHub, create a new repository (for example `classroom-quiz`). It can be private.
2. Upload the contents of the `classroom-quiz` folder so that `index.html` is at the **top level** of the repository, not inside a sub-folder. You can use **Add file → Upload files** on GitHub, or `git push`.
3. **Do not commit your real question-bank JSON files.** They contain the correct answers, and anyone can read a public repository. Keep them on your computer and import them in the dashboard. `.gitignore` already ignores a `question-banks/` folder if you want to keep them next to the project.

**2. Connect Netlify**

1. On Netlify: **Add new site → Import an existing project → GitHub**, then pick the repository.
2. Leave **Build command** empty, and set **Publish directory** to `.`. `netlify.toml` already sets both, so the defaults it shows are fine.
3. Press **Deploy**. Your site appears at `https://<your-site-name>.netlify.app`. You can rename it under **Site configuration → Change site name**, or add your own domain under **Domain management**.
4. Each time you push to GitHub, Netlify publishes the new version automatically.

`netlify.toml` also:
- returns *404 Not found* for `/data/…`, `/question-banks/…`, `README.md` and `firestore.rules`, even if they are in the repository
- tells browsers to check for updates on every visit, so students never run an old copy after you change something
- adds basic security headers, and keeps the teacher pages out of search engines

`404.html` is the "Page not found" page Netlify shows for unknown addresses.

**3. Allow the Netlify address in Firebase (important)**

Firebase console → **Authentication → Settings → Authorized domains → Add domain**:
- add `<your-site-name>.netlify.app`
- add your own domain too, if you use one (for example `quiz.myschool.edu.np`)

If you restricted the API key in **Google Cloud console → APIs & Services →
Credentials** (by "HTTP referrers"), add the same addresses there as
`https://<your-site-name>.netlify.app/*`. An unrestricted key, which is the
default, needs nothing.

**Checking it works:** open the Netlify address, start a quiz as a test
student, then sign in at `/dashboard.html` and look for the attempt. Use
**Delete** on that record to remove the test attempt afterwards.

**Trying it on your own computer:** run a local web server in the folder,
for example `python3 -m http.server 5000`, and open `http://localhost:5000`.
Opening the HTML files by double-clicking does not work, because browsers block
JavaScript modules on `file://` pages.

### 3.6 First use

1. Open `/dashboard.html` and sign in as the teacher.
2. **School settings**: add your grades, and the sections of each grade (sections can have names like *Mount Everest*). Set the default pass mark, and optionally the number of students in each section. That number is the highest roll number students of the section can enter (40 allows 1 to 40), and it also shows how many students have not submitted. Leave it empty for no limit.
3. **Quizzes**: choose your question-bank files, pick the grade for each lesson, choose separate quizzes or a merged quiz, tick **Open the new quizzes for students now**, and press **Add**.
4. Give students the site address.

---

## 4. Question banks (JSON format 2.0)

One file can hold several lessons. When you add a file you choose, per
lesson, whether it becomes **its own quiz** or part of **one merged quiz**.

```json
{
  "schemaVersion": "2.0",
  "title": "Grade 6 Computer Science, lessons 1 to 3",
  "grade": "6",
  "lessons": [
    {
      "lessonId": "lesson-1",
      "title": "Handling and Modeling Data",
      "questions": [
        {
          "id": "q01",
          "question": "Organizing, sorting, and representing data in a meaningful way together make up which process?",
          "type": "multiple_choice",
          "marks": 1,
          "options": [
            { "id": "a", "text": "Handling data" },
            { "id": "b", "text": "Writing computer programs" }
          ],
          "correctAnswer": "a"
        }
      ]
    }
  ]
}
```

| Field | Notes |
|---|---|
| `schemaVersion` | `"2.0"`. Files with `"1.0"` (your current files) still import. |
| `grade` | **New in 2.0.** On the file, or on a lesson (a lesson's grade wins). It must be one of the grades in School settings. If it is missing or unknown, the dashboard asks you to choose the grade before anything is saved. Students only see quizzes of their own grade. |
| `lessonId` | Identifies the lesson. The quiz id is made from the grade and the lesson id (for example `g6-lesson-1`). |
| `title` | The quiz name students see. |
| `questions[].id` | Unique **within its lesson**. The same id (such as `q01`) can appear in other lessons. |
| `type` | `multiple_choice` (or `mcq`), `true_false`, or `short_answer`. |
| `marks` | A positive number. Defaults to 1. |
| `correctAnswer` | The `id` of the correct option (`"a"`). The option's exact text also works. |
| `version`, `passPercent`, `subject`, `description` | Optional, on the file or a lesson. `passPercent` overrides the default pass mark for that quiz. `description` is shown to students. |
| `explanation` | Optional. Teacher only. Never sent to students. |
| `image` | Optional image URL shown with the question. |

For `short_answer` questions use `"acceptedAnswers": ["Central Processing Unit"]`
instead of options. `trimWhitespace` (default true) ignores extra spaces, and
`caseSensitive` (default false) controls upper and lower case.

A lesson with no questions (like Lesson 9 at the moment) is **skipped with a
note**. The older single-lesson format (`{ "metadata": {...}, "questions": [...] }`
with `correctOptionId`) still works; `data/sample-questions.json` is an example.

### Adding quizzes

1. Dashboard → **Quizzes → Add quizzes from question bank files** → choose one or more files.
2. Tick the lessons to use and check the **grade** of each.
3. Choose **Separate quizzes** (each lesson is its own quiz) or **Merge into one quiz** (all ticked lessons, which must have the same grade). A merged quiz keeps the lesson of every question (shown to students and in the analysis), and identical questions are only included once.
4. **If a quiz with the same ID already exists:** *Keep both* (the default) saves the new quiz under a new ID such as `g6-lesson-1-2`. *Replace* updates the existing quiz (its submissions then show **Needs regrading**). Nothing is ever replaced without you choosing it.
5. Check the list of what will be created, and press **Add**.

There is no limit on the number of quizzes. Any problem in a lesson (missing
answer, an answer that matches no option, duplicate ids, invalid JSON) is
listed, and that lesson is not added, so a quiz is never published with
questions silently missing.

The site never reads question files from the server. It only reads the file
you choose, so the answers stay on your computer and in the teacher-only
`answerKeys` collection. **Do not put your question banks in a public GitHub repository.**

### Managing quizzes

**Tabs.** The row at the top of the quiz list holds your own tabs (for
example *Examinations*, *Practice tests*), plus *All quizzes* and
*Uncategorized*. **New tab** creates one; the **⋯** button next to a tab's
name renames or deletes it. Tab names are saved in Firestore, so they are the
same after a refresh, after signing in again and on another computer.

- Quizzes from before tabs existed, and quizzes whose tab was deleted, are in
  *Uncategorized*. Nothing needs migrating.
- **Upload into a tab:** open the tab, then choose the files. Step 3 of the
  preview shows the tab the new quizzes go to, and you can pick another one.
  A quiz that *replaces* an existing one stays in its current tab.
- **Move quizzes:** **⋯ → Move to tab** on a row, or tick several quizzes and
  press **Move to tab** in the bar above the table. Only the quiz's tab
  changes; its ID, grade, lessons, questions, answer key and student records
  stay as they are.
- **Deleting a tab** never deletes quizzes. An empty tab asks for a simple
  confirmation. A tab with quizzes asks where they should go (another tab or
  Uncategorized) and needs a tick before it is deleted.

**The table** can be searched by title or ID and filtered by grade and status
(open, closed, archived), inside the chosen tab. Click a column heading to
sort by it and again to reverse; the arrow shows the sorted column. Sorting
applies to the whole filtered list, not just the rows on screen (the table
shows 200 rows at a time with *Show more*). For each quiz: **Open / Close**,
**Edit** (title, grade, description for students, pass mark), and in the
**⋯** menu **Move to tab**, **View answer key**, **Archive / Unarchive** (an
archived quiz is closed and hidden, nothing is deleted) and **Delete**. To
change the questions of a quiz, add the file again and choose *Replace*.

---

## 5. Using the dashboard

**Results**
- **Browse** by Grade → Section → Quiz. Each choice narrows what is read from Firestore. The choice is remembered.
- **Filter** what is loaded: search by name or roll number, status (in progress, needs grading, graded, pending review, accepted, declined, passed, failed, left the quiz 3+ times, previous attempts), and submission dates. **Clear filters** resets them.
- **Sort** by clicking a column heading.
- **Select** records with the checkboxes (or the header box for all shown). The selection bar offers Grade, Accept, Decline, Print, Export and Archive for the selected records.
- **Print**, **Export** and **More** (Regrade, Archive or Delete all shown) above the table work on every record that matches the current filters. Print offers *Results by student* and *Answer sheets by student*; Export offers *Summary CSV*, *Detailed CSV with answers* and *Backup file*.
- The **⋯** menu on a row: view details, student history, grade or recalculate, accept, decline, mark pending review, print, archive, delete.
- Records load 300 at a time; **Load more** reads the next 300. The dashboard does not update live: press **Refresh** for new submissions.

**Submission states.** A record is *In progress* until the student submits.
After that it has a grading state (*Needs grading*, *Needs regrading* or
*Graded*, with Pass/Fail) and a review state (*Pending review*, *Accepted* or
*Declined*). Declined submissions are kept but are not graded and are left
out of all averages and analysis. Review changes record who made them and when.

**Printing and PDF.** Every print builds **one document**, so the browser's
print dialog (**Save as PDF**) gives a single combined PDF. All reports are
grouped by student. A student is identified by **grade + section + roll
number**, never by name, so two students with the same name stay separate
and different spellings of one student's name are shown together.

| Report | Where | Layout |
|---|---|---|
| **Quiz report** (one attempt) | Result page → Print, or the row menu | Student (name, roll, grade, section), then the quiz summary (marks obtained, total, percentage, status, submitted), then each question: question, student's answer and correct answer side by side, marks awarded / maximum with ✓ or ✗. |
| **Results by student** | Results → Print | Per student: overall performance, then a table of their quizzes (submitted, marks, %, status). No answers. A student with one attempt gets the quiz summary instead. |
| **Answer sheets by student** | Results → Print | As above, followed by every quiz's questions and answers. Each student starts on a new page. |
| **Student history** | Student history → Print (one student or all students shown), with or without answers | The same layout for the student's whole history. |

Pages are A4 with page numbers. Headings stay with the content under them,
a question is never split across pages, and the answer heading repeats when
a quiz's answers continue on the next page. In Chrome or Edge choose *Save as
PDF*, paper A4, and keep *Headers and footers* off.

**How overall performance is calculated.** Only *counted* attempts are used:
graded with the current answer key and **not declined**. Attempts pending
review are counted but labelled as pending (the report shows how many are
accepted and how many pending). In-progress, not graded, needs-regrading and
declined attempts are listed with a "Not counted" note. If a student took
the same quiz more than once, only the latest counted attempt counts.

- **Overall percentage** = total marks obtained ÷ total marks possible × 100 (quizzes with more marks weigh more).
- **Average quiz percentage** = the mean of the counted quizzes' percentages (every quiz weighs the same).
- **Quizzes attempted** counts different quizzes, not attempts.

Example: 1/4 (25%) and 9/10 (90%) give an overall percentage of 10/14 = 71.4%
and an average quiz percentage of (25 + 90) / 2 = 57.5%.

**CSV exports.** Both respect the current filters, or the selection when
exported from the selection bar. Values containing commas, quotes or line
breaks are quoted correctly, and the file opens in Excel with the right
characters. Text that starts with `=`, `+`, `-` or `@` gets a leading `'` so
spreadsheets do not run it as a formula.

- **Summary CSV**, one row per attempt: Student ID, Student name, Roll no., Grade, Section, Quiz ID, Quiz, Attempt ID, Submitted at, Marks obtained, Total marks, Percentage, Result, Grading status, Review status.
- **Detailed CSV**, one row per question: the summary columns plus Question no., Question ID, Lesson, Question, Student's answer, Correct answer, Question result, Marks awarded, Maximum marks. Student ID (grade-section-roll), Quiz ID and Attempt ID stay the same between exports, so rows can be matched in a spreadsheet.

**Result page** (click a student's name): marks, all answers next to the
correct answers, activity log, short-answer overrides, and the per-record
actions (grade/recalculate, accept/decline/pending, print, student history,
allow retake, archive/restore, delete).

**Student history** (its own tab): choose a grade and optionally a section,
then search by name or roll number. The list shows each student's quizzes,
counted quizzes, overall and average percentage. Open a student to see every
attempt across all quizzes (previous attempts and, if ticked, archived
records included), with status badges and "Not counted" notes. Print one
student's history or the histories of all students shown, with or without
answers. The "Student history" links on the Results tab, the result page and
the Analysis tab open this tab directly. Old `student.html?grade=…` links
forward to it.

**Delete.** Deleting needs a confirmation that shows how many records will be
deleted, and deleting more than one record also needs a tick box. The dialog
offers to **download a backup file first** (on by default). Deleted records can
be brought back only from such a backup.

**Archive & backup**
- Archiving moves records out of Results into the archive. They are not deleted, can be viewed, filtered, printed and exported, and can be restored at any time. A student whose record is archived can take that quiz again while it is open; if they did, the restored record gets a new ID instead of overwriting the newer attempt.
- **Export → Backup file** downloads a JSON file with everything needed to restore the records (attempt, answers, result, original timestamps).
- **Import a backup file** checks the file (format and version, required fields, duplicate IDs), shows a preview with counts and a list of skipped records, and asks for confirmation. Records that already exist in Results or the archive are **never overwritten**: they are skipped, or added as separate copies if you choose that. You choose whether the records go into Results or the archive. Original timestamps are kept.

**Analysis**: filters for grade, section, quiz and submission dates. Shows
an overview, grade comparison, sections (highest and lowest, not submitted
when class sizes are set), quizzes, score distribution, students, the hardest
and easiest questions, lesson averages and the weakest lessons. Only graded,
not declined submissions count. Marks are averaged only within one quiz;
across quizzes percentages are used, because quizzes have different totals.

**School settings**: grades, the sections of each grade (add, rename,
remove), class sizes and the default pass mark. Renaming or removing a section
never changes existing records; they keep the name they were submitted with.

---

## 6. Security and limitations (please read)

Firebase **API keys are not secrets.** Anyone can see the key in the page
source. Your data is protected by **Authentication + Security Rules**, which
Firebase enforces on its servers. All of the following are enforced by
`firestore.rules`, not by hiding buttons:

- Students cannot read `answerKeys`, `results`, the archive, `teachers`, closed quizzes or their questions, or anyone else's attempt. They cannot list attempts.
- A student can create only one attempt per quiz and roll number, only for an open, non-archived quiz, **only for a quiz of the grade they entered** (or a version 1 quiz without a grade), with an empty answer sheet, and only for their own anonymous account.
- While the quiz is in progress, a student can change only answers and progress fields. They cannot change their name, roll number, grade, section or question order, answer questions that are not in their quiz, lower their warning counters, or set a review status.
- **A submission must answer every question.**
- After submitting, the student cannot change the attempt. The teacher can only set the review status (accept/decline/pending), copy the record (archive, restore, retake, backup import) and delete it; answers can never be edited.
- Only accounts with a `teachers/{uid}` document can use the dashboard data.

What a frontend-only app **cannot** do:

- **Automatic grading on submit.** Grading needs the answer key, so it happens in the teacher's signed-in dashboard. With Cloud Functions (excluded here) it could run on the server.
- **Verify who a student really is or what grade they are in.** Students do not log in, so they declare their own grade, and someone could type another student's roll number. The grade rule stops a student from starting a quiz of a different grade than the one they entered, but a student could enter a wrong grade. For real identity you would need student accounts.
- **Prevent screenshots or determined cheating.** See the table in section 2.
- **Hide the quiz questions.** Students must receive the questions to answer them. Only the answers are kept secret.
- Someone who knows Firebase could sign in anonymously and create junk attempts for an open quiz. Close quizzes when you are not using them. **Firebase App Check** (with reCAPTCHA) is an optional, frontend-only way to reduce this.

---

## 7. Performance and Firestore usage

- **Students:** the homepage reads the settings, the open-quiz list (small documents without questions) and one status check per quiz. Starting reads one quiz's questions. About 3 writes per student per quiz plus one per 30 seconds of activity.
- **Teacher:** the Results tab reads only the chosen grade/section/quiz, 300 records at a time, plus one small count per grade and section chip. Results are read only for the records on screen. Analysis reads up to 3,000 records for its filters and keeps them in memory until you press Refresh or change data.
- **No live listeners** are used anywhere, so an open dashboard costs nothing.
- **Bulk actions** (grade, review, archive, restore, delete, import) are written in batches of at most 400 writes, with each record's documents in the same batch, so a record is never half moved. If something fails part way, the message says how many records were completed and the rest are untouched.
- **No composite index is needed**: every query uses equality filters plus document-id order, which Firestore serves from its automatic indexes. (This was checked on the emulator, which does not enforce indexes; if the live project ever reports a missing index, the error message contains a link that creates it.)
- The free Spark plan allows 50,000 reads, 20,000 writes and 20,000 deletes per day. A class of 40 taking a quiz and the teacher grading it uses a few hundred.

Measured on the emulator: **40 students taking a 20-question quiz at the
same time** all submitted, with all 20 answers stored, at about 3 writes per
student. An emulator test is not a guarantee for your school network; try a
short quiz with a few students first.

---

## 8. Testing that was done

All tests ran against the Firebase Emulator Suite (Auth + Firestore) with the
real `firestore.rules`, using headless Chromium, on 23 November 2026:

- **Security rules (64 checks):** everything from version 1, plus: quiz content readable only while open; students cannot list or write it; grade 6 student cannot start a grade 7 quiz; quiz without a grade open to all grades; section names with spaces accepted, other characters refused; archived quizzes cannot be started; submission with an unanswered question refused; students cannot set review fields; teacher can set only the review fields, only to valid values; teacher can create record copies; archive teacher-only.
- **End to end, version 2 (68 checks):** settings per grade (rename, class size, new grade with spaced section names); your three real question-bank files: grade required before adding, 8 separate quizzes with grade-prefixed IDs, Lesson 9 skipped; no answers in any list or content document; adding Lesson 1 again keeps both (9 quizzes, nothing replaced); merging lessons 1 to 3 into one 27-question quiz with lesson info on each question; a schema 2.0 file with grade 7; quiz search, grade filter, merged badge, edit (title, pass mark, new key stamp), archive; student: sections follow grade, details remembered after reload, only own-grade open quizzes listed, grade check from the browser console refused, all-answers-required (button disabled, message, rules refusal of a forced incomplete submit, jump to first unanswered), submit, *Completed* status on the homepage, quiz hidden on focus loss, text not selectable, switch student; 340 extra records: paging (300 + load more), section chips with counts, grade all eligible (341 graded), grade → section → quiz scope, accept and decline with timestamp and teacher, declined left out of averages; **combined print** of the accepted students and of all 114 students of one section (one A4 PDF with page numbers); backup export (114 records, timestamps kept); archive 10; bulk delete of 104 with count and tick confirmation; archive tab and restore; backup import with duplicate detection (104 added, 10 skipped) and original timestamps kept; re-import finds only duplicates; analysis with sections and lessons; retake keeps the previous attempt; student history.
- **Version 1 data:** a version 1 quiz (questions inside the quiz document, no grade) and version 1 settings (one shared sections list) were loaded: the student saw the old sections and the old quiz, and took and submitted it.
- **Load:** 40 simultaneous students, 20 questions each: 40/40 submitted, all answers stored, about 3 writes per student.
- **Phase 2: reports and history (49 checks):** three quizzes with different totals; one student with a low quiz, a high quiz, an earlier attempt and a declined attempt, a second student with two name spellings and an in-progress attempt, and a student with the same name in another section. Checked: 3 groups for 7 attempts; same name in another section kept separate; name spellings merged; overall 71.4% (weighted) and average 57.5% (mean); declined, earlier and in-progress attempts listed but not counted; results print without answers; answer sheets with all 46 questions; long question and multi-line answer printed; individual quiz report with the summary first; summary CSV columns, one row per attempt, quiz title with comma and quotes; detailed CSV, one row per question, multi-line answer with quotes and comma read back exactly, stable IDs; export of a selection; Student history tab: list, search by name and roll, section filter, detail with overall and average, print of one student with answers and of all students; history links, old `student.html` links and the Results row link; no horizontal page scroll at phone and tablet width. The PDFs were checked by eye.
- **Design overhaul (18 checks), plus every suite above re-run after it:** no browser dropdown or date field is visible; the styled dropdown opens, filters the table, keeps the real field's value and closes with Escape; Clear resets the dropdown and date labels; picking a day in the date picker filters by date; menus close on an outside click; dropping a file on the picker opens the import preview; Analysis switches views; the student's section dropdown works; Show password works. No sideways page scroll on any dashboard tab at phone and tablet width.
- **Header, icons and key locking (5 checks), plus every suite above re-run after it:** keys work normally before the quiz starts; once it starts F1/F5/F11/F12, Esc, Tab, Alt+Tab, Alt, the Windows key, Home/End, Backspace/Delete and Ctrl+C/F/T/P are blocked; Backspace, Delete, Home/End and Ctrl+Z/A/arrows still work in a text box, and Backspace really deletes typed text; copy/paste, F-keys and Tab stay blocked inside the box. These use simulated key presses in Chromium; the Keyboard Lock behaviour for the real Windows key needs a Windows PC to confirm. No sideways scroll on the homepage or About page at 390px and 360px.
- **Phase 3 (83 checks in the browser, 19 more security-rule checks), plus every suite above re-run after it:** create three tabs (saved in Firestore, shown in order), duplicate and reserved names refused, rename, move one quiz (only `categoryId` changes, no duplicate records), move two at once, tab shows only its quizzes, empty-tab message, upload into the selected tab and into a tab picked in the preview, delete an empty tab, delete a tab with quizzes (confirmation tick required, cancel keeps it, quizzes moved to the chosen tab, none deleted, results untouched), tabs kept after refresh, after signing out and in, and in a second browser; quiz table sorted by title both ways, question count, tab, created date and grade, search + grade + status filters combined with sorting, Open/Close still act on the right quiz after sorting; Student history sorted by name, roll (numeric), section, overall and average % with empty values last in both directions, quizzes attempted, last submitted, search + sort, keyboard sorting, and one student's attempts by %, date and quiz; settings refuse a decimal limit and save 6-A = 5; the student form shows "roll numbers 1 to 5", accepts 1 and 5, refuses 6, 0, -2, 2.5, letters and empty, will not continue with 6, re-checks when the section changes, accepts 6 after the limit is raised to 8 (fresh settings, no reload), blocks starting a quiz after the limit is lowered to 4, the quiz page itself refuses a roll above the limit and creates no attempt, a submit is refused after the limit is lowered (answers kept, attempt unchanged) and succeeds once it is raised; existing records untouched. Rules: rolls 1 and 40 accepted for a limit of 40, 41, 0, 07, -3 and 4.5 refused, other sections' limits used, no limit when none is set or the settings document is missing, submit refused above a lowered limit and allowed after it is raised; only the teacher can change tabs or move quizzes.
- **Netlify:** the Phase 2 suite (49 checks) was run again through Netlify's local server (`netlify dev`) with `netlify.toml` after these changes, and all passed. (The version 2 suite passed there in the version 2 round.) `/data/…`, `README.md` and `firestore.rules` return 404.

**Not tested:** the live Firebase project (only the emulators), real phones
and tablets (only a phone-sized browser window), Safari and Firefox (only
Chromium), and whether Firestore's live service asks for an index for any
query (the emulator never does).

### Testing on your own computer with the emulator

```bash
firebase emulators:start --only firestore,auth
# in another terminal, from the classroom-quiz folder:
python3 -m http.server 5000      # or: netlify dev
```

Open `http://localhost:5000/index.html?emulator=1`. The `?emulator=1` switch
works only on localhost and is remembered for the browser tab.

---

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| "Anonymous sign-in is not enabled" | Do step 3.1. |
| Teacher sees **Access denied** | Create `teachers/{UID}` (step 3.3). The UID is shown on that screen. |
| "You do not have permission" everywhere | The rules are not published, or the teacher document is missing (steps 3.3 and 3.4). |
| "The query requires an index" | Not expected (no index is needed), but if it happens, open the link in the error message to create the index, wait a few minutes, and press Refresh. |
| Students see "There are no quizzes for Grade 6" | Open the quiz on the **Quizzes** tab, check it is not archived, and check its grade matches the student's grade. |
| A student's grade or section disappeared | It was removed in School settings. The student is asked to choose again; their old records are unchanged. |
| The print preview has extra text at the top and bottom | Turn off *Headers and footers* in the print dialog. |
| A student is blocked with "already started on another device" | Someone used their roll number, or they switched devices. Open that record and press **Allow retake** (the old attempt is kept). |
| A student's computer crashed mid-quiz | On the same computer and browser, they can continue where they left off. On another device, use **Allow retake**. |
| Submissions show **Needs regrading** | The answer key changed. Press **Grade all eligible**. |
| "Powered by Netlify" or a Netlify bar appears | It is not in this site's code. On deploy previews and branch deploys Netlify adds its **Netlify Drawer** toolbar: you can turn it off in your Netlify site settings (look for **Netlify Drawer** or the deploy-preview toolbar setting; the menu name has changed between Netlify versions). A Netlify-branded page appears only when Netlify itself shows a default error page (for example a site that failed to deploy); this site has its own `404.html`. The live production address shows no Netlify branding. |

---

## 10. Version 2.0: changes and upgrading

### What changed

- Student homepage with remembered details, a quiz list for the student's grade and a status per quiz; switching students on shared devices.
- Every question must be answered before submitting (page and security rules).
- More screenshot and copying deterrents (hide on focus loss and screenshot keys, watermark, no selection), clearly described as deterrents.
- "Classroom Quiz" links to the student homepage on every page; the teacher pages have a separate "Teacher dashboard" link.
- Unlimited quizzes with unique IDs; adding never replaces a quiz unless you choose *Replace*. (Version 1 used the lesson id as the quiz id, so lessons with the same id in different files replaced each other; that is why only three quizzes seemed to fit.)
- JSON format 2.0 with `grade`; grade-based quiz visibility, enforced by the rules when a quiz is started.
- Merging several lessons into one quiz, with lesson information kept on every question.
- Quiz management: search, grade filter, badges, edit, archive, delete.
- Sections per grade in School settings.
- Results by grade → section → quiz, paging, selection and bulk actions.
- Review states (pending, accepted, declined) with timestamps; per-record and bulk grading.
- Combined print/PDF of many students; individual print.
- Archive and restore; backup export and import with duplicate detection.
- Student history; allow retake keeps the old attempt.
- Analysis by grade, section, quiz, student, question and lesson, with date filters.

### Upgrade steps (no data is deleted or rewritten)

1. **Publish the new `firestore.rules`** (step 3.4). This must be done, otherwise new quizzes cannot be read by students and archive, review and restore are refused.
2. Upload the new files to GitHub (replace the old ones). Netlify publishes them automatically. Students get the new version on their next visit.
3. Sign in to the dashboard, open **School settings**, check the sections of each grade, and press **Save settings** once. (Until then the old shared section list is used for every grade, so nothing breaks.)
4. Your existing quizzes, attempts and results keep working as they are:
   - Version 1 quizzes keep their questions inside the quiz document and are read from there. They have no grade, so every grade sees them until you set one with **Edit**.
   - Old attempts have no review status; they show as *Pending review*.
   - Nothing is migrated automatically, and no old document is changed until you edit it.
5. Optional: to move a version 1 quiz to the new storage, add its question-bank file again and choose *Replace*. Its results then show *Needs regrading*.
6. Optional: delete the old composite index on `attempts` (`quizId`, `startedAt`) under **Firestore → Indexes**. It is no longer used.

Version 1 links still work: `index.html`, `quiz.html`, `dashboard.html` and
`result.html?id=…` keep their names.

### Phase 2 (reports, history, polish)

- **Student history** is a tab on the dashboard, next to Results, with search and printing.
- **Reports** are grouped by student (grade + section + roll), with overall percentage and average quiz percentage, and clear "Not counted" notes. The individual quiz report puts the summary first and lays questions out one by one.
- **Two CSV exports:** summary (one row per attempt) and detailed (one row per question).
- **Look and feel:** shorter help texts; one height for buttons and fields; the same corner radius, badge and status colours everywhere; table rows highlight on hover; menus stay on screen on phones; a bug that made the Results page scroll sideways on tablets is fixed.
- **No data changes:** Firestore collections, documents and security rules are unchanged. Just upload the new files.

### Phase 3 (quiz tabs, sortable tables, roll number limits)

- **Quiz tabs:** see *Managing quizzes* in section 4. Tabs are stored in `settings/quizCategories`; each quiz has a `categoryId` field. Tab edits run in a transaction so two open dashboards cannot overwrite each other.
- **One sorting system:** `js/tableSort.js` is used by Results, Archive, Quizzes and both Student history tables. Numbers sort as numbers, dates by time, text naturally (Lesson 2 before Lesson 10); empty values always go last; headings can be sorted with the keyboard (Tab to the heading, then Enter).
- **Student history:** every data column sorts (student, roll, grade, section, quizzes, counted, overall %, average %, and a new *Last submitted* column), and so does one student's list of attempts (quiz, name used, submitted, status, marks, %, left).
- **Roll number limits:** the *Students* number of a section in School settings is now enforced. With 40, roll numbers 1 to 40 are accepted; 0, 41, negative numbers, decimals, letters and empty values are refused with a message such as "Invalid roll number. This section allows roll numbers from 1 to 40." It is checked while typing, when the details are saved, when a quiz is started (with settings read fresh) and again before the quiz is submitted, and **the security rules check it too** when an attempt is created and when it is submitted. Lowering a limit never changes or deletes existing records; a student above the new limit cannot start or submit until the teacher raises it or the student corrects the roll number, and their saved answers are kept meanwhile.
- **Upgrade:** publish the new `firestore.rules` (section 3.4). No data migration and no index are needed. Roll number 0 is no longer accepted for new attempts.

### Design overhaul

- **Teacher sign-in:** a two-panel sign-in page with a Show password button and the Forgot password link beside the field.
- **Dashboard layout:** a sidebar groups the pages (Records: Results, Student history, Analysis · Content: Quizzes · Data: Archive & backup, School settings). Each page has a title and a one-line description. On phones and tablets the sidebar becomes a scrollable bar at the top.
- **No browser-default controls:** every dropdown and date field is a styled control (`js/controls.js`) with keyboard support (arrow keys, Enter, Escape, first-letter search). Checkboxes, radio buttons and file pickers (with drag and drop) are styled too. The real form fields stay in the page, hidden, so nothing else changed.
- **Less on one screen:** Analysis is split into Overview, Sections, Quizzes, Students and Questions & lessons. School settings puts grades on the left and Add grade, pass mark and Save on the right. The result page keeps Accept, Decline, Print and Student history in view and moves the rest into a More menu.
- **Teacher login in the header:** the student pages have an About link and a Teacher login button at the top right. On phones About becomes an icon, and on very small phones both do.
- **Icons:** every button, link button and menu item gets a Font Awesome 6.5.2 icon (loaded from cdnjs) chosen by `js/icons.js` from its label, so new buttons get one automatically. Add `data-icon="name"` to a button to pick an icon, or `data-icon="none"` for no icon.
- **Typography and spacing:** headings use Plus Jakarta Sans and text uses Inter (Google Fonts), with more space around cards, fields and pages.
- **Micro-interactions:** buttons lift and press, arrows nudge on hover, menus and dropdowns pop in, dialogs rise in and tab panels fade in. All of it is turned off for people who choose reduced motion on their device.
- **About page and credit:** `about.html` describes the site and credits the creator with a link to https://www.instagram.com/mainaliukesh.143783333/. The same credit is in the footer of the student pages and on the teacher sign-in page.
- **Alignment:** every filter has a label above it, so fields and buttons in a row line up; rows that mix text and buttons are centred on one line.
