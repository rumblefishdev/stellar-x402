-- A PDF has no repository next to it, so a relative link such as
-- `../runbook.md` points nowhere once rendered. Rewrite every
-- relative link to its GitHub URL at REF; in-document anchors (`#…`), absolute
-- URLs and images are left alone.
local REPO = "https://github.com/rumblefishdev/stellar-x402/"
local BASE = "docs/scf/"   -- the directory the evidence documents live in
-- The tag the submission points at, so a link shows what the PDF describes, not a later run.
local REF = "tranche-1-evidence"

local function normalize(path)
  local parts = {}
  for seg in path:gmatch("[^/]+") do
    if seg == ".." then
      if #parts == 0 then error("repo-links.lua: a link climbs above the repository root: " .. path) end
      table.remove(parts)
    elseif seg ~= "." then table.insert(parts, seg) end
  end
  return table.concat(parts, "/")
end

function Link(el)
  local t = el.target
  if t:match("^%a[%w+.-]*:") or t:sub(1, 1) == "#" then return nil end
  local path, anchor = t:match("^([^#]*)(#?.*)$")
  local dir = path:sub(-1) == "/"
  -- A leading / is the repository root, not this directory.
  local base = path:sub(1, 1) == "/" and "" or BASE
  el.target = REPO .. (dir and "tree" or "blob") .. "/" .. REF .. "/" .. normalize(base .. path) .. (dir and "/" or "") .. anchor
  return el
end
