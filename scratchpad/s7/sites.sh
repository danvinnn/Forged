echo "=== run.ts : where a reading is CHOSEN between passes or dropped"
grep -n "keepFirst\|first\.\|second\.\|?? \|continue;\|delete \|= undefined" src/lib/extraction/run.ts | grep -vE "^\s*[0-9]+:\s*(//|\*)" | wc -l
echo "=== merge.ts : where a model value is dropped or replaced"
grep -n "continue;\|return null\|= stated\|rejected.push\|skipped.push" src/lib/extraction/merge.ts | grep -vE ":\s*(//|\*)" | wc -l
echo "=== exporters.ts : where a record value is blanked, substituted or overridden"
grep -n "= null\|?? \|discards.push\|continue;" src/lib/exporters.ts | grep -vE ":\s*(//|\*)" | wc -l
