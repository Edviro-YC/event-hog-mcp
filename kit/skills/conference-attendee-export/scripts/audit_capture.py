#!/usr/bin/env python3
"""Audit one normalized attendee capture using Python's standard library."""
import argparse
import collections
import copy
import json
from pathlib import Path


def audit(capture, expected=None):
    issues, people, fingerprints, numeric = [], {}, {}, collections.defaultdict(set)
    conflicts, duplicate_ids, raw_count = set(), 0, 0
    pages = capture.get('pages', [])
    if not isinstance(pages, list) or not pages:
        raise ValueError('pages must be a nonempty list')
    if capture.get('error'):
        issues.append('Capture has an unresolved error')
    for index, page in enumerate(pages):
        partition, number = str(page.get('partition', 'default')), page.get('page')
        if page.get('error'):
            issues.append(f'Unresolved error in unit {index + 1}')
        if isinstance(number, int) and not isinstance(number, bool):
            numeric[partition].add(number)
        rows = page.get('rows')
        if not isinstance(rows, list):
            raise ValueError(f'rows must be a list in unit {index + 1}')
        keys = []
        for row in rows:
            raw_count += 1
            source_id, profile = row.get('id'), row.get('profile_url')
            if source_id is not None and (isinstance(source_id, bool) or not isinstance(source_id, (str, int))):
                raise ValueError('id must be text, integer, or null')
            if source_id is not None and str(source_id).strip():
                key = ('id', str(source_id))
            elif isinstance(profile, str) and profile.strip():
                key = ('url', profile.strip())
            else:
                raise ValueError(f'Row in unit {index + 1} lacks stable id/profile_url')
            fields = []
            for field in ('name', 'title', 'company'):
                value = row.get(field)
                if value is not None and not isinstance(value, str):
                    raise ValueError(f'{field} must be text or null')
                fields.append((value or '').strip())
            fields = tuple(fields)
            keys.append(key)
            if key in people:
                duplicate_ids += 1
                if people[key] != fields:
                    conflicts.add(key)
            else:
                people[key] = fields
        fingerprint = (partition, tuple(sorted(keys)))
        locator = number if number is not None else page.get('url', index)
        if keys and fingerprint in fingerprints and fingerprints[fingerprint] != locator:
            issues.append(f'Repeated nonempty results within partition {partition}')
        fingerprints[fingerprint] = locator
    for partition, numbers in numeric.items():
        start = min(numbers)
        if start not in (0, 1) or len(numbers) != max(numbers) - start + 1:
            issues.append(f'Missing initial/intermediate pages in partition {partition}')
    evidence = capture.get('end_evidence', {})
    terminal = any(evidence.get(k) is True for k in
                   ('next_disabled', 'empty_page_verified', 'partition_reconciliation_verified'))
    terminal = terminal or ('api_has_more' in evidence and evidence['api_has_more'] is False)
    if capture.get('ended') is not True or not terminal:
        issues.append('Accessible-scope terminal evidence is missing')
    if conflicts:
        issues.append('Conflicting source fields for repeated identities')
    if expected is not None and expected != len(people):
        issues.append(f'Expected {expected} identities; captured {len(people)}')
    values = list(people.values())
    companies = collections.Counter(row[2] for row in values if row[2])
    triples = collections.Counter(values)
    return {
        'event': capture.get('event'), 'source_url': capture.get('source_url'),
        'capture_started_utc': capture.get('started_at'),
        'capture_completed_utc': capture.get('completed_at'),
        'capture_units': len(pages), 'raw_records': raw_count, 'unique_records': len(people),
        'duplicate_identity_occurrences': duplicate_ids,
        'conflicting_identities': [{'kind': k, 'value': v} for k, v in sorted(conflicts)],
        'distinct_identities_sharing_displayed_fields': sum(n for n in triples.values() if n > 1),
        'missing_fields': {f: sum(not row[i] for row in values)
                           for i, f in enumerate(('name', 'title', 'company'))},
        'distinct_company_labels': len(companies), 'company_count_sum': sum(companies.values()),
        'expected_count': expected, 'terminal_evidence_recorded': terminal,
        'status': 'needs_review' if issues else 'pass', 'issues': sorted(set(issues)),
        'scope_note': 'Checks recorded evidence; does not independently verify source traversal.'
    }


def self_test():
    row = {'id': 'a', 'name': 'Same Name', 'title': 'Lead', 'company': '\u00a0'}
    capture = {'ended': True, 'end_evidence': {'next_disabled': True},
               'pages': [{'page': 1, 'rows': [row, {**row, 'id': 'b'}]}]}
    result = audit(capture, 2)
    assert result['status'] == 'pass' and result['missing_fields']['company'] == 2
    assert result['distinct_identities_sharing_displayed_fields'] == 2
    overlap = copy.deepcopy(capture)
    overlap['pages'].append({'page': 2, 'rows': [row]})
    assert audit(overlap)['duplicate_identity_occurrences'] == 1
    overlap['pages'][-1]['rows'][0] = {**row, 'title': 'Changed'}
    assert audit(overlap)['status'] == 'needs_review'
    gap = copy.deepcopy(capture)
    gap['pages'].append({'page': 3, 'rows': [{**row, 'id': 'c'}]})
    assert audit(gap)['status'] == 'needs_review'
    missing = copy.deepcopy(capture)
    missing['end_evidence'] = {}
    assert audit(missing)['status'] == 'needs_review'
    repeated = copy.deepcopy(capture)
    repeated['pages'].append({'page': 2, 'rows': [row, {**row, 'id': 'b'}]})
    assert audit(repeated)['status'] == 'needs_review'
    assert audit(capture, 3)['status'] == 'needs_review'
    fallback = copy.deepcopy(capture)
    fallback['pages'][0]['rows'] = [{'profile_url': 'https://example.test/p/1', 'name': 'Ada'}]
    assert audit(fallback, 1)['status'] == 'pass'
    fallback['pages'][0]['rows'][0].pop('profile_url')
    try:
        audit(fallback)
    except ValueError:
        pass
    else:
        raise AssertionError('Missing identity should be rejected')
    print('Passed identity, overlap, conflict, page-gap, terminal, total and Unicode-blank checks.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('capture', nargs='?', type=Path)
    parser.add_argument('--expected-count', type=int)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    if not args.capture:
        parser.error('capture is required unless --self-test is used')
    if args.expected_count is not None and args.expected_count < 0:
        parser.error('--expected-count must be nonnegative')
    try:
        report = audit(json.loads(args.capture.read_text(encoding='utf-8')), args.expected_count)
    except (ValueError, TypeError, AttributeError, OSError) as error:
        parser.exit(2, f'Invalid capture: {error}\n')
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.write_text(rendered, encoding='utf-8')
    print(rendered, end='')
    return 0 if report['status'] == 'pass' else 2


if __name__ == '__main__':
    raise SystemExit(main())
