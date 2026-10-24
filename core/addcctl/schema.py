# SPDX-License-Identifier: LGPL-2.1-or-later
"""The subset of JSON Schema the operations use, so that addcctl needs no
library beyond Samba's: type, properties, required, additionalProperties,
items, enum, minLength, maxLength, minimum, maximum."""

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "null": lambda v: v is None,
}


def errors(schema, value, path="input"):
    """Every way value breaks schema, as English sentences."""
    types = schema.get("type")
    if types is not None:
        types = types if isinstance(types, list) else [types]
        if not any(_TYPES[t](value) for t in types):
            return ["%s must be %s" % (path, " or ".join(types))]
    found = []
    if "enum" in schema and value not in schema["enum"]:
        found.append("%s must be one of %s" % (path, ", ".join(map(str, schema["enum"]))))
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            found.append("%s must not be empty" % path if schema["minLength"] == 1
                         else "%s must be at least %d characters" % (path, schema["minLength"]))
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            found.append("%s must be at most %d characters" % (path, schema["maxLength"]))
    if _TYPES["integer"](value):
        if "minimum" in schema and value < schema["minimum"]:
            found.append("%s must be at least %d" % (path, schema["minimum"]))
        if "maximum" in schema and value > schema["maximum"]:
            found.append("%s must be at most %d" % (path, schema["maximum"]))
    if isinstance(value, list) and "items" in schema:
        for i, item in enumerate(value):
            found += errors(schema["items"], item, "%s[%d]" % (path, i))
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                found.append("%s.%s is required" % (path, key))
        for key, item in value.items():
            if key in props:
                found += errors(props[key], item, "%s.%s" % (path, key))
            elif schema.get("additionalProperties") is False:
                found.append("%s.%s is not a known setting" % (path, key))
    return found
