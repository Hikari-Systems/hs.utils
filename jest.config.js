module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node',
  testPathIgnorePatterns: ['/node_modules/', '/es5/'],
  transform: {
    '^.+\\.[tj]sx?$': [
      'ts-jest',
      {
        tsconfig: {
          allowJs: true,
          target: 'ES2021',
          module: 'commonjs',
          esModuleInterop: true,
          strict: false,
          isolatedModules: true,
        },
      },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!uuid/)'],
};
