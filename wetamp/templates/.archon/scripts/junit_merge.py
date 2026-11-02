#!/usr/bin/env python3
import copy
import os
import sys
import tempfile
import xml.etree.ElementTree as ET

if sys.version_info < (3, 9):
    raise SystemExit("junit_merge.py requires Python 3.9 or newer")


def case_id(case: ET.Element) -> str:
    attrs = case.attrib
    legacy = f"{attrs.get('classname', '')}::{attrs.get('name', '')}"
    file = attrs.get("file")
    classname = attrs.get("classname")
    name = attrs.get("name")
    if not file or not classname or not name:
        return legacy
    normalized = file.replace("\\", "/")
    module = normalized.removesuffix(".py").split("/")
    parts = classname.split(".")
    for length in range(min(len(module), len(parts)), 0, -1):
        if module[-length:] == parts[:length]:
            return "::".join([normalized, *parts[length:], name])
    return legacy

def suites(root: ET.Element):
    if root.tag == "testsuite":
        return [root]
    if root.tag != "testsuites":
        raise ValueError("JUnit root must be testsuite or testsuites")
    return list(root.findall("testsuite"))


def indexed(root: ET.Element):
    result = {}
    def visit(suite):
        for case in suite.findall("testcase"):
            identity = case_id(case)
            if identity in result:
                raise ValueError(f"duplicate testcase id: {identity}")
            result[identity] = (suite, case)
        for child in suite.findall("testsuite"):
            visit(child)

    for suite in suites(root):
        visit(suite)
    return result


def update_statistics(element: ET.Element) -> tuple[int, int, int, int]:
    totals = [0, 0, 0, 0]
    if element.tag == "testsuite":
        for case in element.findall("testcase"):
            totals[0] += 1
            totals[1] += case.find("failure") is not None
            totals[2] += case.find("error") is not None
            totals[3] += case.find("skipped") is not None
    for child in element.findall("testsuite"):
        child_totals = update_statistics(child)
        totals = [left + right for left, right in zip(totals, child_totals)]
    for name, value in zip(("tests", "failures", "errors", "skipped"), totals):
        element.set(name, str(value))
    return tuple(totals)

def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("usage: junit_merge.py BASE RERUN ID [ID ...]")
    base_path, rerun_path, *selected = sys.argv[1:]
    base = ET.parse(base_path)
    rerun = ET.parse(rerun_path)
    base_cases, rerun_cases = indexed(base.getroot()), indexed(rerun.getroot())
    if set(selected) - base_cases.keys() or set(selected) - rerun_cases.keys():
        raise ValueError("selected testcase id missing from base or rerun report")
    for identity in selected:
        suite, old = base_cases[identity]
        index = list(suite).index(old)
        suite.remove(old)
        suite.insert(index, copy.deepcopy(rerun_cases[identity][1]))
    update_statistics(base.getroot())
    fd, temp = tempfile.mkstemp(prefix="junit-merge-", dir=os.path.dirname(base_path) or ".")
    os.close(fd)
    try:
        base.write(temp, encoding="utf-8", xml_declaration=True)
        os.replace(temp, base_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

if __name__ == "__main__":
    main()
