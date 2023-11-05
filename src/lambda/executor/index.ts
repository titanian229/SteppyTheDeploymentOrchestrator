// This Lambda is responsible for executing different step types
class Executor {
  types: {
    [key: string]: {
      handler: (params: any) => Promise<any>;
      paramValidator: (params: any) => boolean;
    };
  };

  constructor() {
    this.types = {};
  }

  registerType(type: string | number, handler: any, paramValidator = null) {
    this.types[type] = { handler, paramValidator: paramValidator || (() => true) };
  }
}
