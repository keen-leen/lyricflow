UUID := lyricflow@keen.local
PACKAGE := $(UUID).zip
BUILD_DIR := dist
OPENCC_MODULES := node_modules/opencc-js/dist/esm-lib

.PHONY: all build check test shell-test pack install clean

all: build

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

build: node_modules/.package-lock.json
	rm -rf $(BUILD_DIR)
	npm run build
	mkdir -p $(BUILD_DIR)/schemas $(BUILD_DIR)/locale/zh_CN/LC_MESSAGES $(BUILD_DIR)/vendor/licenses $(BUILD_DIR)/vendor/preset
	glib-compile-schemas --strict --targetdir=$(BUILD_DIR)/schemas schemas
	cp metadata.json stylesheet.css $(BUILD_DIR)/
	cp schemas/*.xml $(BUILD_DIR)/schemas/
	cp -R $(addprefix $(OPENCC_MODULES)/,core.js dict from to) $(BUILD_DIR)/vendor/
	cp $(addprefix $(OPENCC_MODULES)/preset/,t2cn.js cn2t.js) $(BUILD_DIR)/vendor/preset/
	cp node_modules/opencc-js/LICENSE node_modules/opencc-js/THIRD_PARTY_LICENSES.md $(BUILD_DIR)/vendor/licenses/
	cp node_modules/opencc-js/LICENSES/Apache-2.0.txt $(BUILD_DIR)/vendor/licenses/
	msgfmt po/zh_CN.po -o $(BUILD_DIR)/locale/zh_CN/LC_MESSAGES/lyricflow.mo

check: node_modules/.package-lock.json
	npm run check

test: node_modules/.package-lock.json
	npm test

shell-test: pack
	dbus-run-session -- gnome-shell-test-tool --headless --disable-animations \
		--extension $(PACKAGE) tests/integration/shell-scroll-test.js

pack: build
	rm -f $(PACKAGE)
	cd $(BUILD_DIR) && zip -9r ../$(PACKAGE) . -x \
		schemas/gschemas.compiled types.js vendor/from/index.js vendor/to/index.js

install: pack
	gnome-extensions install --force $(PACKAGE)

clean:
	rm -rf $(BUILD_DIR) .test-dist schemas/gschemas.compiled $(PACKAGE)
