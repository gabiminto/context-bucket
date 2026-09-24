# builds and moves plugin to vault folder
npm run build
rm -rf /Users/gabi/CodingProjects/plugin-development/.obsidian/plugins/context-bucket
mkdir -p /Users/gabi/CodingProjects/plugin-development/.obsidian/plugins/context-bucket
cp main.js manifest.json styles.css /Users/gabi/CodingProjects/plugin-development/.obsidian/plugins/context-bucket/
obsidian vault=plugin-development reload
