UUID := lyricflow@keen.local
PACKAGE := $(UUID).zip
BUILD_DIR := dist

.PHONY: all build check test pack install clean

all: build

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

build: node_modules/.package-lock.json
	npm run build
	glib-compile-schemas schemas
	mkdir -p $(BUILD_DIR)/schemas $(BUILD_DIR)/locale/zh_CN/LC_MESSAGES
	cp metadata.json stylesheet.css $(BUILD_DIR)/
	cp schemas/*.xml schemas/gschemas.compiled $(BUILD_DIR)/schemas/
	msgfmt po/zh_CN.po -o $(BUILD_DIR)/locale/zh_CN/LC_MESSAGES/lyricflow.mo

check: node_modules/.package-lock.json
	npm run check

test: node_modules/.package-lock.json
	npm test

pack: build test
	rm -f $(PACKAGE)
	cd $(BUILD_DIR) && zip -9r ../$(PACKAGE) .

install: pack
	gnome-extensions install --force $(PACKAGE)

clean:
	rm -rf $(BUILD_DIR) .test-dist schemas/gschemas.compiled $(PACKAGE)
