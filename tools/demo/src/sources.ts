/**
 * The demo project: a small student management system in C++ (6 .cpp + 6 .h). Each piece is
 * tagged with how it gets into the files during the scripted session.
 */

/** Starter code handed out by the course (in the folder before recording starts). */
export const UTILS_H = `#pragma once
#include <algorithm>
#include <cctype>
#include <string>

// Starter code provided by the course.
inline std::string trim(const std::string& s) {
    auto begin = std::find_if_not(s.begin(), s.end(), [](unsigned char c) { return std::isspace(c); });
    auto end = std::find_if_not(s.rbegin(), s.rend(), [](unsigned char c) { return std::isspace(c); }).base();
    return begin < end ? std::string(begin, end) : std::string();
}

inline std::string toLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}
`;

export const MAIN_CPP_STARTER = `#include <iostream>

int main() {
    // TODO: build the management system menu here
    return 0;
}
`;

export const STUDENT_H = `#pragma once
#include <string>

struct Student {
    int id = 0;
    std::string name;
    std::string email;
};

bool isValidId(int id);
bool isValidEmail(const std::string& email);
std::string describe(const Student& s);
`;

export const IS_VALID_ID = `bool isValidId(int id) {
    return id > 0 && id < 100000;
}
`;

export const STUDENT_CPP = `#include "student.h"
#include "utils.h"
#include <sstream>

${IS_VALID_ID}
bool isValidEmail(const std::string& email) {
    auto at = email.find('@');
    return at != std::string::npos && at > 0 && email.find('.', at) != std::string::npos;
}

std::string describe(const Student& s) {
    std::ostringstream out;
    out << "#" << s.id << " " << trim(s.name) << " <" << toLower(s.email) << ">";
    return out.str();
}
`;

/** course.h is typed with a wrong field first ("seats"), undone, then the right one. */
export const COURSE_H_BEFORE = `#pragma once
#include <string>

struct Course {
    int id = 0;
    std::string code;
    std::string title;
    `;
export const COURSE_H_WRONG = 'int seats = 30;';
export const COURSE_H_RIGHT = 'int capacity = 30;';
export const COURSE_H_AFTER = `
};

bool isValidCourseId(int id);
std::string describe(const Course& c);
`;

export const COURSE_CPP_DESCRIBE = `
std::string describe(const Course& c) {
    std::ostringstream out;
    out << c.code << " - " << c.title << " (" << c.capacity << " seats)";
    return out.str();
}
`;

/** Session 1 version (Kilo Code adds drop() and studentsIn() in session 2). */
export const ENROLLMENT_H_V1 = `#pragma once
#include "course.h"
#include "student.h"
#include <map>
#include <vector>

class Registry {
public:
    bool addStudent(const Student& s);
    bool addCourse(const Course& c);
    bool enroll(int studentId, int courseId);
    const std::map<int, Student>& students() const { return students_; }
    const std::map<int, Course>& courses() const { return courses_; }

private:
    std::map<int, Student> students_;
    std::map<int, Course> courses_;
    std::map<int, std::vector<int>> enrolled_;  // course id -> student ids
};
`;
export const KILO_INSERT_AFTER = '    bool enroll(int studentId, int courseId);\n';
export const KILO_INSERT = `    bool drop(int studentId, int courseId);
    std::vector<Student> studentsIn(int courseId) const;
`;

export const ENROLLMENT_CPP_V1 = `#include "enrollment.h"
#include <algorithm>

bool Registry::addStudent(const Student& s) {
    if (!isValidId(s.id) || !isValidEmail(s.email)) return false;
    return students_.emplace(s.id, s).second;
}

bool Registry::addCourse(const Course& c) {
    if (!isValidCourseId(c.id)) return false;
    return courses_.emplace(c.id, c).second;
}

bool Registry::enroll(int studentId, int courseId) {
    auto course = courses_.find(courseId);
    if (course == courses_.end() || !students_.count(studentId)) return false;
    auto& list = enrolled_[courseId];
    if (static_cast<int>(list.size()) >= course->second.capacity) return false;
    if (std::find(list.begin(), list.end(), studentId) != list.end()) return false;
    list.push_back(studentId);
    return true;
}
`;
/** Session 2: the student types the signatures, Copilot completes the bodies. */
export const DROP_SIGNATURE = '\nbool Registry::drop(int studentId, int courseId) {\n';
export const COPILOT_DROP_BODY = `    auto& list = enrolled_[courseId];
    auto it = std::find(list.begin(), list.end(), studentId);
    if (it == list.end()) return false;
    list.erase(it);
    return true;
}
`;
export const STUDENTS_IN_SIGNATURE = '\nstd::vector<Student> Registry::studentsIn(int courseId) const {\n';
export const COPILOT_STUDENTS_IN_BODY = `    std::vector<Student> out;
    auto it = enrolled_.find(courseId);
    if (it == enrolled_.end()) return out;
    for (int id : it->second) out.push_back(students_.at(id));
    return out;
}
`;

export const STORAGE_H = `#pragma once
#include "enrollment.h"
#include <string>
#include <vector>

std::vector<std::string> splitCsv(const std::string& line);
bool saveRegistry(const Registry& reg, const std::string& path);
bool loadRegistry(Registry& reg, const std::string& path);
`;

export const STORAGE_CPP_HEAD = `#include "storage.h"
#include <fstream>
#include <sstream>

// split() adapted from a StackOverflow answer (see the note in the log)
`;
/** Pasted from a web page. */
export const STACKOVERFLOW_SPLIT = `std::vector<std::string> splitCsv(const std::string& line) {
    std::vector<std::string> fields;
    std::stringstream ss(line);
    std::string item;
    while (std::getline(ss, item, ',')) {
        fields.push_back(item);
    }
    return fields;
}
`;
export const STORAGE_CPP_REST = `
bool saveRegistry(const Registry& reg, const std::string& path) {
    std::ofstream out(path);
    if (!out) return false;
    for (const auto& [id, s] : reg.students()) out << "S," << id << "," << s.name << "," << s.email << "\\n";
    for (const auto& [id, c] : reg.courses()) out << "C," << id << "," << c.code << "," << c.title << "," << c.capacity << "\\n";
    return true;
}

bool loadRegistry(Registry& reg, const std::string& path) {
    std::ifstream in(path);
    if (!in) return false;
    std::string line;
    while (std::getline(in, line)) {
        auto f = splitCsv(line);
        if (f.size() >= 4 && f[0] == "S") reg.addStudent({std::stoi(f[1]), f[2], f[3]});
        if (f.size() >= 5 && f[0] == "C") reg.addCourse({std::stoi(f[1]), f[2], f[3], std::stoi(f[4])});
    }
    return true;
}
`;
/** What Claude Code (in a terminal) writes over loadRegistry in session 2. */
export const CLAUDE_LOAD_OLD = `        auto f = splitCsv(line);
        if (f.size() >= 4 && f[0] == "S") reg.addStudent({std::stoi(f[1]), f[2], f[3]});
        if (f.size() >= 5 && f[0] == "C") reg.addCourse({std::stoi(f[1]), f[2], f[3], std::stoi(f[4])});
`;
export const CLAUDE_LOAD_NEW = `        auto f = splitCsv(line);
        try {
            if (f.size() >= 4 && f[0] == "S") reg.addStudent({std::stoi(f[1]), f[2], f[3]});
            if (f.size() >= 5 && f[0] == "C") reg.addCourse({std::stoi(f[1]), f[2], f[3], std::stoi(f[4])});
        } catch (const std::exception&) {
            continue;  // skip malformed lines
        }
`;

/** Written by Claude Code while VS Code was closed (between session 1 and 2). */
export const REPORT_H = `#pragma once
#include "enrollment.h"
#include <ostream>

void printCourseReport(const Registry& reg, std::ostream& out);
void printStudentList(const Registry& reg, std::ostream& out);
`;
export const REPORT_CPP = `#include "report.h"
#include <iomanip>

void printCourseReport(const Registry& reg, std::ostream& out) {
    out << std::left << std::setw(10) << "Code" << std::setw(30) << "Title" << "Enrolled\\n";
    for (const auto& [id, c] : reg.courses()) {
        out << std::setw(10) << c.code << std::setw(30) << c.title << reg.studentsIn(id).size() << "/"
            << c.capacity << "\\n";
    }
}

void printStudentList(const Registry& reg, std::ostream& out) {
    for (const auto& [id, s] : reg.students()) out << describe(s) << "\\n";
}
`;
export const REPORT_TYPED_AFTER = `            << c.capacity << "\\n";
    }
`;
export const REPORT_TYPED = '    out << reg.courses().size() << " courses in total\\n";\n';

/** main.cpp, session 1: includes and the menu for choices 1–3. */
export const MAIN_INCLUDES = '#include "enrollment.h"\n#include "storage.h"\n';
export const MAIN_TODO = '    // TODO: build the management system menu here\n';
export const MAIN_BODY_V1 = `    Registry reg;
    if (!loadRegistry(reg, "registry.csv")) std::cout << "starting with an empty registry\\n";
    int choice = -1;
    while (choice != 0) {
        std::cout << "\\n1) Add student  2) Add course  3) Enroll  4) Report  0) Save and exit\\n> ";
        if (!(std::cin >> choice)) break;
        if (choice == 1) {
            Student s;
            std::cout << "id name email: ";
            std::cin >> s.id >> s.name >> s.email;
            std::cout << (reg.addStudent(s) ? "added\\n" : "invalid student\\n");
        } else if (choice == 2) {
            Course c;
            std::cout << "id code title capacity: ";
            std::cin >> c.id >> c.code >> c.title >> c.capacity;
            std::cout << (reg.addCourse(c) ? "added\\n" : "invalid course\\n");
        } else if (choice == 3) {
            int sid = 0, cid = 0;
            std::cout << "student id, course id: ";
            std::cin >> sid >> cid;
            std::cout << (reg.enroll(sid, cid) ? "enrolled\\n" : "could not enroll\\n");
        }
    }
    if (!saveRegistry(reg, "registry.csv")) std::cout << "could not save\\n";
`;
/** Session 2: the student adds the include, Copilot suggests the report branch. */
export const MAIN_REPORT_INCLUDE = '#include "report.h"\n';
export const MAIN_BRANCH_ANCHOR = `            std::cout << (reg.enroll(sid, cid) ? "enrolled\\n" : "could not enroll\\n");
        }`;
export const COPILOT_MAIN_BRANCH = ` else if (choice == 4) {
            printCourseReport(reg, std::cout);
            printStudentList(reg, std::cout);
        }`;

/** A throwaway test the student writes in the lab and deletes the next day. */
export const SCRATCH = `#include "../storage.h"
#include <iostream>

int main() {
    for (const auto& f : splitCsv("S,1,Ali,ali@uni.edu")) std::cout << f << "\\n";
}
`;
