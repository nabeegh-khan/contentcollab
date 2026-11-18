# Stand-in curl for scripts/spaces-verify.test.mjs: the anonymous read of an uploaded object.
#   STUB_ANON_CODE=200  the object is readable without a key (default 403, the private answer)
echo "$*" >> "$STUB_DIR/curl.argv"
printf '%s' "${STUB_ANON_CODE:-403}"
