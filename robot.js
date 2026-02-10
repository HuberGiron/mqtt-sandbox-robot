class Robot {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.theta = 0; // en radianes
    this.l = 50; // distancia al punto de control
    this.k = 0.1; // ganancia de control
    this.dt = 0.1; // paso de tiempo
    this.trajectory = [];
  }

  setInitialConditions(x, y, theta) {
    this.x = x;
    this.y = y;
    this.theta = theta * Math.PI / 180; // convertir a radianes
    this.trajectory = [{ x: this.x, y: this.y }];
  }

  /**
   * Calcula la acción de control y actualiza la posición del robot.
   * Retorna el error en x, y y los valores de V y W para usarlos en las gráficas.
   */
  calculateControl(xs, ys) {
    const x_ext = this.x + this.l * Math.cos(this.theta);
    const y_ext = this.y + this.l * Math.sin(this.theta);

    const ex = x_ext - xs;
    const ey = y_ext - ys;

    const ux = -this.k * ex;
    const uy = -this.k * ey;

    const A = [
      [Math.cos(this.theta), -this.l * Math.sin(this.theta)],
      [Math.sin(this.theta), this.l * Math.cos(this.theta)]
    ];

    const detA = A[0][0] * A[1][1] - A[0][1] * A[1][0];
    const invA = [
      [A[1][1] / detA, -A[0][1] / detA],
      [-A[1][0] / detA, A[0][0] / detA]
    ];

    const V = invA[0][0] * ux + invA[0][1] * uy;
    const W = invA[1][0] * ux + invA[1][1] * uy;

    // Actualizamos la pose
    this.theta += W * this.dt;
    this.x += V * Math.cos(this.theta) * this.dt;
    this.y += V * Math.sin(this.theta) * this.dt;

    this.trajectory.push({ x: this.x, y: this.y });

    // Retornamos para registrar en las gráficas
    return { ex, ey, V, W };
  }

  getCurrentPosition() {
    return { x: this.x, y: this.y };
  }

  getTrajectory() {
    return this.trajectory;
  }

  getExtensionPoint() {
    return {
      x: this.x + this.l * Math.cos(this.theta),
      y: this.y + this.l * Math.sin(this.theta)
    };
  }
}
