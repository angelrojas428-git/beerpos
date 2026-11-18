const path = require('path');

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'admin.html'),
    path.join(__dirname, 'js/**/*.js')
  ],
  theme: {
    extend: {}
  },
  darkMode: 'class',
  plugins: []
};
