# Classroom Quiz

A small quiz website for Grade 6 students, plus a teacher dashboard for results.
Built with plain **HTML, CSS and JavaScript** and **Firebase** (Firestore,
Authentication) and runs on any static host, such as **Netlify** from a
GitHub repository. It has no server code, no Cloud Functions and
no frameworks. Firebase is loaded from Google's CDN (SDK version 12.19.0, set in
`js/firebase.js`).

- **Students** open the site, enter their name, roll number, grade and section, and take a quiz one question at a time. They need no account and no password.
- **The teacher** signs in to `dashboard.html` to import question banks, open or close quizzes, grade submissions, and view, search, sort, filter, analyse and export results.

---

## 1. Files

```text
classroom-quiz/
├── index.html            Student start page (details form, quiz choice)
├── quiz.html             The quiz (one question at a time)
├── dashboard.html        Teacher dashboard (results, analysis, quizzes, settings)
├── result.html           One student's detailed result (teacher only)
├── css/
│   ├── style.css         Shared design (colours, buttons, forms, cards)
│   ├── quiz.css          Student pages
│   └── dashboard.css     Teacher pages
├── js/
│   ├── firebase.js       Firebase config + initialisation (the only place the SDK is imported)
│   ├── auth.js           Anonymous student sign-in, teacher sign-in and check
│   ├── utilities.js      Shared helpers (settings, formatting, CSV, storage)
│   ├── student.js        index.html logic
│   ├── quiz.js           quiz.html logic (navigation, saving, submitting)
│   ├── randomizer.js     Question and option shuffling
│   ├── antiCheat.js      Copy, right-click and tab-switch deterrents
│   ├── submission.js     Student Firestore reads/writes (attempts)
│   ├── questionBank.js   JSON question-bank importer (teacher only)
│   ├── grading.js        Marking logic (teacher only)
│   ├── dashboard.js      dashboard.html logic
│   ├── analytics.js      Grade and section summaries
│   └── result.js         result.html logic
├── data/
│   └── sample-questions.json   Example of the older single-lesson format (blocked on Netlify)
├── firestore.rules       Security rules (the real protection)
├── firestore.indexes.json
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
| `settings/school` | Grades, sections, pass mark, class sizes | Any signed-in user | Teacher |
| `quizzes/{quizId}` | Title, question text, options, marks. **No correct answers.** | Students: open quizzes only. Teacher: all | Teacher |
| `answerKeys/{quizId}` | Correct option ids, accepted short answers, explanations | **Teacher only** | Teacher |
| `attempts/{attemptId}` | Student details, random question order, selected answers, warnings, timestamps | The student who created it, and the teacher | The student (until submitted). The teacher can only delete. |
| `results/{attemptId}` | Calculated marks, per-question correctness, teacher overrides | **Teacher only** | Teacher |

`attemptId` is `quizId_grade_section_roll`, for example
`grade-6-lesson-1_6_A_12`. Because the id is fixed, each student can have **only
one attempt per quiz**, and the rules reject a second one. Results use the same
id, so grading again overwrites the result instead of creating a duplicate.

### Student workflow

1. The student opens the site. Firebase signs them in **anonymously** in the background.
2. They fill in their details and choose an **open** quiz. The site checks whether this student already has an attempt for this quiz.
3. On **Begin**, the quiz shuffles the question order and the option order of every question, and saves that order in the attempt. Previous and Next never reshuffle, and neither does a refresh.
4. Every answer is saved to the browser's local storage immediately. That costs nothing and survives a refresh. Progress is also saved to Firestore at most once every 30 seconds, when the student opens the review screen, and when they leave the page.
5. The review screen shows answered and unanswered questions. A confirmation dialog comes before the final submit.
6. Submitting is **one write** that sets `status: "submitted"`. After that the rules lock the attempt.
7. If the internet is down, the student sees a clear "NOT submitted yet" message. The answers stay on the device, and the submit is retried automatically when the connection returns.

### Teacher grading workflow

1. The teacher signs in. The dashboard lists attempts and marks submitted ones without a result as **Needs grading**.
2. **Grade now** loads the answer key (allowed only for the teacher), compares each submission in the browser, and writes `results/{attemptId}`.
3. The results table, summary cards and analysis update straight away.
4. When a question bank is imported again (for example after fixing an answer), every affected result shows **Needs regrading** until **Grade now** or **Regrade all** is pressed. Overrides the teacher made by hand are kept.

Correct answers are **never sent to student browsers**. The student pages load
only `quizzes/{id}`, and that document has no answers. This was checked by
capturing all of a student's network traffic during the tests.

---

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

### 3.4 Publish the security rules and index

**Option A: Firebase CLI (recommended).** The CLI is a tool on your own
computer for deploying. It is not server code. You need Node.js installed.

```bash
npm install -g firebase-tools
firebase login
cd classroom-quiz
firebase deploy --only firestore:rules,firestore:indexes
```

**Option B: Firebase console.**

1. **Firestore Database → Rules**: replace everything with the contents of `firestore.rules`, then **Publish**.
2. **Firestore Database → Indexes → Composite → Create index**: collection `attempts`, fields `quizId` Ascending and `startedAt` Descending, query scope *Collection*. (Or, the first time you pick a single quiz in the dashboard, open the link in the browser console error and Firebase fills this in for you.)

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
**Allow retake** to remove the test attempt afterwards.

**Trying it on your own computer:** run a local web server in the folder,
for example `python3 -m http.server 5000`, and open `http://localhost:5000`.
Opening the HTML files by double-clicking does not work, because browsers block
JavaScript modules on `file://` pages.

### 3.6 First use

1. Open `/dashboard.html` and sign in as the teacher.
2. **Settings**: set the grades (for example `6`), the sections (for example `A, B, C, D`) and the pass mark. Optionally fill in class sizes, to see how many students have not submitted.
3. **Quizzes**: import your question-bank JSON and tick **Open for students now**.
4. Give students the site address.

---

## 4. Question banks

### Format

The importer reads the format of your lesson files: one file holds several
lessons, and **each lesson becomes its own quiz** that students can choose.

```json
{
  "schemaVersion": "1.0",
  "title": "Lessons 1 3",
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
            { "id": "b", "text": "Writing computer programs" },
            { "id": "c", "text": "Creating animations" },
            { "id": "d", "text": "Communicating online" }
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
| `lessonId` | Becomes the quiz id (for example `lesson-1`). Letters, numbers, `.`, `-` and `_` only. **Keep it the same** when you update a lesson, or it is imported as a new quiz. |
| `title` | The quiz name students see. |
| `questions[].id` | Must be unique **within its lesson**. The same id (such as `q01`) can be reused in other lessons. |
| `type` | `multiple_choice` (or `mcq`), `true_false`, or `short_answer`. |
| `marks` | A positive number. Defaults to 1. |
| `correctAnswer` | The `id` of the correct option (`"a"`). The option's exact text also works. |
| `grade` | Optional, on a lesson. If set, only students who choose that grade see the quiz. Your current files have none, so every grade sees every lesson. |
| `version`, `passPercent` | Optional, on a lesson. `passPercent` overrides the pass mark from Settings for that quiz. |
| `explanation` | Optional. Teacher only, shown on the result page. Never sent to students. |
| `image` | Optional image URL shown with the question. |

For `short_answer` questions, use `"acceptedAnswers": ["Central Processing Unit"]`
instead of options. `trimWhitespace` (default true) ignores extra spaces, and
`caseSensitive` (default false) controls upper and lower case.

A lesson with an empty `questions` list (like Lesson 9 at the moment) is
**skipped with a note** in the preview. Import the file again once questions
have been added, and the lesson appears as a new quiz.

The earlier single-lesson format (`{ "metadata": {...}, "questions": [...] }`
with `correctOptionId`) still works too. `data/sample-questions.json` is an
example of it.

### Adding or updating a question bank

1. Dashboard → **Quizzes → Import a question bank** → choose the file(s).
2. Check the preview. Any problem (missing answer, an answer that matches no option, duplicate ids, invalid JSON) is listed, and **that lesson is not imported**, so a quiz is never published with questions silently missing.
3. Press **Import**. Importing a lesson whose id already exists **replaces** it, and its submissions show **Needs regrading**.

Avoid removing or renaming question ids while students are in the middle of
that quiz. The preview warns you when this would happen.

The site never reads question files from the server. It only reads the file
you choose in the dashboard, so the answers stay on your computer and in the
teacher-only `answerKeys` collection.

---

## 5. Using the dashboard

- **Quiz selector:** pick one quiz, or *All quizzes*. With one quiz, marks are shown. With all quizzes, percentages are used, because marks from different quizzes cannot be compared.
- **Summary cards:** total students, submissions, average, highest and lowest marks, and the number of ungraded submissions.
- **Grade now:** grades every submission that has no current result. **Regrade all** grades every loaded submission again.
- **Table:** click any column heading to sort, and click again to reverse. Search by name or roll number. Filter by grade, section and status (graded, needs grading, in progress, passed, failed, *left the quiz 3+ times*). Filters combine. **Clear filters** resets them, and the match count is shown.
- **Click a row** to open the student's result. It shows marks, correct, incorrect and unanswered counts, submission time, time taken, every answer next to the correct answer, and the activity log.
  - **Short answers** can be overridden (*Mark correct* or *Mark incorrect*), for example for a small spelling mistake. Overrides survive regrading.
  - **Allow retake** deletes that student's attempt and result, so they can start again with the same details.
- **Export CSV:** downloads the rows currently shown, with filters applied. The file opens in Excel or Google Sheets.
- **Analysis:** pass/fail counts, grade-wise and section-wise tables (students, not submitted, average, highest, lowest, pass and fail), a score distribution, and, for a single quiz, questions sorted from hardest to easiest.
- **Quizzes:** open or close quizzes, view an answer key, delete a quiz.
- The dashboard does not update live. Press **Refresh** to load new submissions. This avoids constant database reads.

---

## 6. Security and limitations (please read)

Firebase **API keys are not secrets.** Anyone can see the key in the page
source. Your data is protected by **Authentication + Security Rules**, which
Firebase enforces on its servers. All of the following are enforced by
`firestore.rules`, not by hiding buttons:

- Students cannot read `answerKeys`, `results`, `teachers`, closed quizzes, or anyone else's attempt. They cannot list attempts.
- A student can create only one attempt per quiz and roll number, only for an open quiz, with an empty answer sheet, and only for their own anonymous account.
- While the quiz is in progress, a student can change only their answers and progress fields. They cannot change their name, roll number, grade, section or question order, cannot answer questions that are not in their quiz, and cannot lower their warning counters.
- After submitting, nobody can change the attempt. The teacher can delete it to allow a retake, but cannot edit it.
- Only accounts with a `teachers/{uid}` document can use the dashboard data.

What a frontend-only app **cannot** do:

- **Automatic grading on submit.** Grading needs the answer key, and any code that runs in the student's browser could reveal it. Without a server (Cloud Functions are excluded here), grading happens in the teacher's signed-in dashboard. With Cloud Functions, grading could run automatically on the server the moment a student submits. That would be the only change needed, if that restriction is ever lifted.
- **Verify who a student really is.** Students do not log in, so someone could type another student's roll number. The fixed attempt id means they would block that student rather than add a second attempt. The teacher sees the attempt and can delete it with **Allow retake**. For stronger identity you would need student accounts.
- **Stop determined cheating.** The anti-cheat features (no right-click, copy, paste or text selection on questions, blocked shortcuts, fullscreen prompt, tab-switch warnings and counting, print blocking) only discourage casual cheating. They cannot stop screenshots, photos of the screen, a second device, help from others, or someone editing the page code. Fullscreen cannot be enforced, and iPhones do not support it. The counts are hints, not proof.
- **Hide the quiz questions.** Students must receive the questions to answer them. Only the answers are kept secret.
- Someone who knows Firebase could sign in anonymously and create junk attempts for an open quiz. Close quizzes when you are not using them. **Firebase App Check** (with reCAPTCHA) is an optional, frontend-only way to reduce this abuse further.

---

## 7. Performance and Firestore usage

Measured on the Firebase emulator with **40 students taking a 20-question quiz
at the same time**: all 40 submitted successfully, with about **3 writes per
student** (start, review and submit), plus one more write for each 30 seconds a
student spends on the quiz. Rough cost of one class of 40:

| Action | Reads | Writes |
|---|---|---|
| Each student: settings + open-quiz list + quiz + duplicate check (+1 read in the rules) | about 5 + number of open quizzes | 1 (start) |
| Each student during the quiz | 0 | about 1 per 30 s of activity, plus the review screen |
| Each student: submit | 0 | 1 |
| Teacher opens the dashboard | 1 per attempt + 1 per result + quizzes | 0 |
| Teacher grades 40 submissions | 1 per quiz (answer key) | 40 |

That is far below the free Spark plan's daily limits (50,000 reads, 20,000
writes and 20,000 deletes per day, 1 GiB storage). Notes:

- An emulator test is not a guarantee for your school network. Try a short quiz with a few students first. The main real-world risk is the school's internet connection, which the site handles by saving answers on the device and retrying.
- Each student writes only to their own document, so there are no hot-spot limits for a class.
- A quiz document can hold a few thousand questions (the Firestore document limit is 1 MiB).
- The dashboard loads 500 attempts at a time. **Load more** fetches the next 500.
- Choosing a single quiz in the dashboard uses the composite index from `firestore.indexes.json`.

---

## 8. Testing that was done

All tests ran against the Firebase Emulator Suite (Auth + Firestore) with the
real `firestore.rules`, using headless Chromium:

- **Security rules (42 checks):** answer keys, results and teachers unreadable by students; no cross-student reads; attempt id must match the student's details; no duplicate attempts; no identity or order changes; answers only for the quiz's own questions; no edits after submit; teacher-only listing, grading and deleting; non-teacher accounts denied.
- **End to end (69 checks):** form validation and name and roll normalisation; quiz start; one question at a time; Previous and Next without reshuffling; refresh restores answers and position; tab-switch warning and counting (a refresh is not counted); copy and right-click blocking; review warning for unanswered questions; triple-clicking Submit gives one submission; duplicate attempts blocked on the same and other devices; console tampering denied; **no answers in the student's network traffic**; offline submit fails clearly and retries automatically when back online; random question and option order differs per student; teacher login, wrong password and unauthorised account; JSON import with invalid and broken files; grading (including a case- and space-insensitive short answer); regrading without duplicates; teacher override kept after regrade; re-import marks results for regrading; search, filters, combined filters, sorting, empty states; CSV export; analysis tables; retake; closed quizzes hidden from students.
- **Load:** 40 simultaneous students, 20 questions each: 40/40 submitted, all answers stored.
- **Your real question banks (11 checks):** all three files import with no errors. Lessons 1 to 8 become 8 quizzes with 69 questions, and Lesson 9 is skipped with a note. No answers appear in any student-visible quiz document. A student took Lesson 1, and it was graded correctly against your answer key.
- **Netlify:** both browser suites above were run again through Netlify's own local server (`netlify dev`) using `netlify.toml`, and all checks passed. Every page, script and stylesheet loads, and `/data/…`, `README.md` and `firestore.rules` return 404.

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
| Dashboard error when a single quiz is picked | The composite index is missing or still building (step 3.4). Wait a few minutes. |
| Students see "No quiz is open right now" | Open the quiz on the **Quizzes** tab, and check its grade matches the student's grade. |
| A student is blocked with "already started on another device" | Someone used their roll number, or they switched devices. Open that row and press **Allow retake**. |
| A student's computer crashed mid-quiz | On the same computer and browser, they can continue where they left off. On another device, use **Allow retake**. |
| Submissions show **Needs regrading** | The answer key changed. Press **Grade now**. |
