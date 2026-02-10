let errorChart, positionChart, controlChart;

function initCharts(timeData, errorXData, errorYData, posXData, posYData, VData, WData) {
  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 }, // Actualización instantánea (sin animación)
    scales: {
      x: {
        title: { display: true, text: 'Tiempo (s)' },
        grid: { display: false },
        ticks: {
          autoSkip: true,
          maxTicksLimit: 10
        }
      },
      y: {
        title: { display: true, text: 'Valor' },
        grid: { display: false }
      }
    },
    plugins: {
      legend: {
        display: true
      }
    }
  };

  errorChart = new Chart(document.getElementById('errorChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'Error X (mm)',
          data: errorXData,
          borderColor: 'red',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Error Y (mm)',
          data: errorYData,
          borderColor: 'blue',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: commonOptions
  });

  positionChart = new Chart(document.getElementById('positionChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'Posición X (mm)',
          data: posXData,
          borderColor: 'green',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'Posición Y (mm)',
          data: posYData,
          borderColor: 'orange',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: commonOptions
  });

  controlChart = new Chart(document.getElementById('controlChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: timeData,
      datasets: [
        {
          label: 'V (mm/s)',
          data: VData,
          borderColor: 'purple',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        },
        {
          label: 'W (rad/s)',
          data: WData,
          borderColor: 'gray',
          borderWidth: 1,
          fill: false,
          tension: 0.1,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 0 }, // Actualización instantánea
      scales: {
        x: {
          title: { display: true, text: 'Tiempo (s)' },
          grid: { display: false },
          ticks: {
            autoSkip: true,
            maxTicksLimit: 10
          }
        },
        y: {
          title: { display: true, text: 'Valor' },
          grid: { display: false }
        }
      },
      plugins: {
        legend: {
          display: true
        }
      }
    }
  });
}

function updateCharts(timeData, errorXData, errorYData, posXData, posYData, VData, WData) {
  errorChart.data.labels = timeData;
  errorChart.data.datasets[0].data = errorXData;
  errorChart.data.datasets[1].data = errorYData;

  positionChart.data.labels = timeData;
  positionChart.data.datasets[0].data = posXData;
  positionChart.data.datasets[1].data = posYData;

  controlChart.data.labels = timeData;
  controlChart.data.datasets[0].data = VData;
  controlChart.data.datasets[1].data = WData;

  errorChart.update();
  positionChart.update();
  controlChart.update();
}

function downloadChart(chartInstance, fileName) {
  const link = document.createElement('a');
  link.href = chartInstance.toBase64Image();
  link.download = fileName + '.png';
  link.click();
}

function downloadCSVForChart(chartType) {
  let csv = '';
  let fileName = '';
  if (chartType === 'error') {
    fileName = 'error_chart_data';
    csv += 'Tiempo (s),Error X (mm),Error Y (mm)\n';
    for (let i = 0; i < timeData.length; i++) {
      csv += timeData[i] + ',' + errorXData[i] + ',' + errorYData[i] + '\n';
    }
  } else if (chartType === 'position') {
    fileName = 'position_chart_data';
    csv += 'Tiempo (s),Posición X (mm),Posición Y (mm)\n';
    for (let i = 0; i < timeData.length; i++) {
      csv += timeData[i] + ',' + posXData[i] + ',' + posYData[i] + '\n';
    }
  } else if (chartType === 'control') {
    fileName = 'control_chart_data';
    csv += 'Tiempo (s),V (mm/s),W (rad/s)\n';
    for (let i = 0; i < timeData.length; i++) {
      csv += timeData[i] + ',' + VData[i] + ',' + WData[i] + '\n';
    }
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement("a");
  if (link.download !== undefined) {
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", fileName + ".csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
}
