#!/usr/bin/env python3
"""Replace selected cases in a complete JUnit report with rerun results."""

import copy
import os
import sys
import tempfile

from junitparser import JUnitXml, TestCase, TestSuite


def case_id(case) -> str:
    attrs = case._elem.attrib
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


def indexed(xml):
    result = {}
    def visit(suite):
        for case in suite.iterchildren(TestCase):
            identity = case_id(case)
            if identity in result:
                raise ValueError(f"duplicate testcase id: {identity}")
            result[identity] = (suite, case)
        for child in suite.iterchildren(TestSuite):
            visit(child)

    for suite in xml:
        visit(suite)
    return result


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit("usage: junit_merge.py BASE RERUN ID [ID ...]")
    base_path, rerun_path, *selected = sys.argv[1:]
    base = JUnitXml.fromfile(base_path)
    rerun = JUnitXml.fromfile(rerun_path)
    base_cases, rerun_cases = indexed(base), indexed(rerun)
    if set(selected) - base_cases.keys() or set(selected) - rerun_cases.keys():
        raise ValueError("selected testcase id missing from base or rerun report")
    for identity in selected:
        suite, old = base_cases[identity]
        suite.remove(old)
        suite.append(copy.deepcopy(rerun_cases[identity][1]))
    base.update_statistics()
    fd, temp = tempfile.mkstemp(prefix="junit-merge-", dir=os.path.dirname(base_path) or ".")
    os.close(fd)
    try:
        base.write(temp)
        os.replace(temp, base_path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


if __name__ == "__main__":
    main()
